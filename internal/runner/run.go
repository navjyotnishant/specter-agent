package runner

import (
	"context"
	"fmt"
	"strings"
	"sync"

	"github.com/navjyotnishant/specter-agent/internal/graph"
)

// defaultMaxParallel matches DEFAULT_MAX_PARALLEL_NODES in Python.
const defaultMaxParallel = 3

// RunWorkflow executes a graph level by level.
//
// Concurrency is per level: nodes in one level have no dependency between them.
// Whether they actually run concurrently is the supervisor's choice, matching
// Python — a workflow authored for sequential delegation must not suddenly run
// its agents in parallel just because a different backend started it.
func (r *Runner) RunWorkflow(ctx context.Context, runID, workflowID string, g graph.Graph, workspace string, runInput map[string]string) {
	if len(g.Nodes) == 0 {
		r.setRunStatus(runID, "failed")
		r.writeLog(runID, "error", "No nodes in workflow graph.", nil)
		return
	}

	levels := g.Levels()
	maxParallel := maxParallelNodes(g.Nodes)
	mode := "sequential"
	if maxParallel > 1 {
		mode = "parallel"
	}
	r.writeLog(runID, "info",
		fmt.Sprintf("Starting %s run: %d nodes across %d levels.", mode, len(g.Nodes), len(levels)),
		map[string]any{"run_id": runID})
	r.setRunStatus(runID, "running")

	// Trigger values are seeded into the shared context so they reach the first
	// agent's prompt. BuildPrompt already folds context into each node's
	// instructions, so nothing else has to know about triggers.
	accumulated := triggerContext(g.Nodes, runInput)
	if accumulated != "" {
		r.writeLog(runID, "info", "Trigger input supplied: "+strings.Join(sortedKeys(runInput), ", "), nil)
	}

	for _, level := range levels {
		if ctx.Err() != nil {
			r.writeLog(runID, "info", "Run cancelled — stopping before next node.", nil)
			r.setRunStatus(runID, "cancelled")
			return
		}

		// Skip nodes that already completed, folding their summary back into
		// context. THIS IS THE RESUME MECHANISM: a run that suspended at an
		// approval and started again must not re-run the work it already did,
		// because an agent that already wrote files would write them twice.
		var pending []graph.Node
		for _, node := range level {
			status, summary, found := r.latestStepForNode(runID, node.ID)
			switch {
			case found && status == "completed":
				if summary != "" {
					accumulated += "\n\n[" + nodeLabel(node) + "]\n" + summary
				}
			case found && status == "skipped":
				// Unreachable after a conditional branch; leave it alone.
			default:
				pending = append(pending, node)
			}
		}
		if len(pending) == 0 {
			continue
		}

		results := r.runLevel(ctx, runID, pending, workspace, accumulated, maxParallel)

		var failedLabel, failedSummary string
		for i, result := range results {
			label := nodeLabel(pending[i])
			if result.Status == "cancelled" {
				r.setRunStatus(runID, "cancelled")
				return
			}
			if result.Status == "failed" && failedLabel == "" {
				failedLabel, failedSummary = label, result.Summary
			}
			if result.Status == "completed" && result.Summary != "" {
				accumulated += "\n\n[" + label + "]\n" + result.Summary
			}
		}

		// Stop at the first failure. Continuing runs later nodes on a broken
		// premise — they would report on work that never happened.
		if failedLabel != "" {
			r.setRunStatus(runID, "failed")
			r.writeLog(runID, "error", "Run failed at node: "+failedLabel,
				map[string]any{"summary": failedSummary})
			return
		}
	}

	// The last summary becomes the run's result: it is what a trigger
	// integration reports back to the user.
	r.setFinalReport(runID)
	r.setRunStatus(runID, "completed")
	r.writeLog(runID, "info", "Workflow run completed successfully.", nil)
}

// runLevel executes one level, concurrently when the supervisor asked for it.
// Results come back in INPUT order regardless, so a failure is attributed to the
// right node.
func (r *Runner) runLevel(ctx context.Context, runID string, nodes []graph.Node, workspace, context_ string, maxParallel int) []NodeResult {
	if len(nodes) == 1 || maxParallel <= 1 {
		results := make([]NodeResult, 0, len(nodes))
		for _, node := range nodes {
			results = append(results, r.RunNode(ctx, runID, node, workspace, context_))
		}
		return results
	}

	if len(nodes) > 1 {
		r.writeLog(runID, "info",
			fmt.Sprintf("Running %d nodes in parallel (max %d concurrent).", len(nodes), maxParallel), nil)
	}

	results := make([]NodeResult, len(nodes))
	slots := make(chan struct{}, maxParallel)
	var wg sync.WaitGroup
	for i, node := range nodes {
		wg.Add(1)
		go func(i int, node graph.Node) {
			defer wg.Done()
			slots <- struct{}{}
			defer func() { <-slots }()
			results[i] = r.RunNode(ctx, runID, node, workspace, context_)
		}(i, node)
	}
	wg.Wait()
	return results
}

// latestStepForNode reports the most recent step for a node, if any.
func (r *Runner) latestStepForNode(runID, nodeID string) (status, summary string, found bool) {
	var summaryValue *string
	err := r.Store.DB().QueryRow(
		`SELECT status, summary FROM agent_runs
		  WHERE workflow_run_id = ? AND node_id = ?
		  ORDER BY started_at DESC LIMIT 1`, runID, nodeID).Scan(&status, &summaryValue)
	if err != nil {
		return "", "", false
	}
	if summaryValue != nil {
		summary = *summaryValue
	}
	return status, summary, true
}

func (r *Runner) setRunStatus(runID, status string) {
	var completed any
	if status == "completed" || status == "failed" || status == "cancelled" {
		completed = now()
	}
	r.Store.DB().Exec(
		`UPDATE workflow_runs SET status = ?, completed_at = ? WHERE id = ?`,
		status, completed, runID)
}

func (r *Runner) setFinalReport(runID string) {
	var summary string
	err := r.Store.DB().QueryRow(
		`SELECT summary FROM agent_runs
		  WHERE workflow_run_id = ? AND summary IS NOT NULL AND summary != ''
		  ORDER BY completed_at DESC LIMIT 1`, runID).Scan(&summary)
	if err != nil || summary == "" {
		return
	}
	r.Store.DB().Exec(`UPDATE workflow_runs SET final_report = ? WHERE id = ?`, summary, runID)
}

// triggerContext renders trigger values as the run's opening context.
//
// Labelled with the trigger's own label, so the prompt reads "Topic: ..."
// rather than dumping a bare string the agent has to guess the meaning of. The
// marker matters: this is the user's instruction, not an earlier step's output,
// and BuildPrompt frames the two differently.
func triggerContext(nodes []graph.Node, runInput map[string]string) string {
	var lines []string
	for _, node := range nodes {
		if node.Type != "trigger" {
			continue
		}
		field := strings.TrimSpace(node.Data.FieldName)
		if field == "" {
			field = "input"
		}
		value := strings.TrimSpace(runInput[field])
		if value == "" {
			continue
		}
		label := strings.TrimSpace(node.Data.Label)
		if label == "" {
			label = field
		}
		lines = append(lines, label+": "+value)
	}
	if len(lines) == 0 {
		return ""
	}
	return TriggerMarker + strings.Join(lines, "\n")
}

// maxParallelNodes reads the supervisor's delegation strategy. Defaults to
// sequential: a workflow authored without parallel delegation must not start
// running its agents concurrently because a different backend executed it.
func maxParallelNodes(nodes []graph.Node) int {
	for _, node := range nodes {
		if node.Type != "supervisorAgent" {
			continue
		}
		switch strings.TrimSpace(node.Data.DelegationStrategy) {
		case "parallel_delegation", "parallel_delegation_later":
			return defaultMaxParallel
		}
		return 1
	}
	return 1
}

func nodeLabel(node graph.Node) string {
	if label := strings.TrimSpace(node.Data.Label); label != "" {
		return label
	}
	return node.ID
}

func sortedKeys(m map[string]string) []string {
	if len(m) == 0 {
		return []string{"none"}
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	// Sorted so the log line is stable between runs.
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0 && keys[j] < keys[j-1]; j-- {
			keys[j], keys[j-1] = keys[j-1], keys[j]
		}
	}
	return keys
}
