// Tests for the run loop: walking levels, threading context between nodes,
// stopping on failure, and terminating the run.
//
// Two behaviours here are the resume mechanism in disguise, and they live in the
// MAIN loop rather than a separate path:
//
//   - a node whose latest step is already 'completed' is not re-run; its summary
//     is folded back into the accumulated context instead
//   - a run whose nodes are all complete finishes rather than starting over
//
// That is what makes R4 (approval resume) a small change on top of this rather
// than a second execution engine.
package runner

import (
	"context"
	"strings"
	"testing"

	"github.com/navjyotnishant/specter-agent/internal/graph"
	"github.com/navjyotnishant/specter-agent/internal/store"
)

func seedGraphRun(t *testing.T, s *store.Store, runID string, g graph.Graph) string {
	t.Helper()
	workspace := t.TempDir()
	if _, err := s.DB().Exec(
		`INSERT OR IGNORE INTO workflows (id, name, graph_json) VALUES ('wf1', 'Test', '{}')`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB().Exec(
		`INSERT INTO workflow_runs (id, workflow_id, status, workspace_path, graph_json)
		 VALUES (?, 'wf1', 'queued', ?, '{}')`, runID, workspace); err != nil {
		t.Fatal(err)
	}
	return workspace
}

func agent(id, label string) graph.Node {
	return graph.Node{ID: id, Type: "specialistAgent",
		Data: graph.NodeData{Label: label, Role: "reviewer", Objective: "look"}}
}

func runStatus(t *testing.T, s *store.Store, runID string) string {
	t.Helper()
	var status string
	if err := s.DB().QueryRow(`SELECT status FROM workflow_runs WHERE id = ?`, runID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	return status
}

func TestASingleNodeRunCompletes(t *testing.T) {
	r, s, runID := testRunner(t)
	r.AgentPath = fakeAgent(t, `echo "all good"`)
	g := graph.Graph{Nodes: []graph.Node{agent("n1", "Reviewer")}}

	r.RunWorkflow(context.Background(), runID, "wf1", g, t.TempDir(), nil)

	if got := runStatus(t, s, runID); got != "completed" {
		t.Fatalf("run status = %q, want completed", got)
	}
	// The last summary becomes the run's final report — it is what a trigger
	// integration reports back to the user.
	var report *string
	s.DB().QueryRow(`SELECT final_report FROM workflow_runs WHERE id = ?`, runID).Scan(&report)
	if report == nil || !strings.Contains(*report, "all good") {
		t.Errorf("final_report = %v, want the last node's summary", report)
	}
}

func TestNodesRunInDependencyOrderAndContextFlowsForward(t *testing.T) {
	// The second node must see the first node's output. Without this each node
	// starts blind and the graph is just a list.
	r, s, runID := testRunner(t)
	// The fake agent echoes back the prompt it was given, so the second node's
	// stored output reveals whether it saw the first node's summary.
	r.AgentPath = fakeAgent(t, `echo "PROMPT-WAS: $@"`)

	g := graph.Graph{
		Nodes: []graph.Node{agent("n1", "First"), agent("n2", "Second")},
		Edges: []graph.Edge{{ID: "e1", Source: "n1", Target: "n2"}},
	}
	r.RunWorkflow(context.Background(), runID, "wf1", g, t.TempDir(), nil)

	if got := runStatus(t, s, runID); got != "completed" {
		t.Fatalf("run status = %q", got)
	}

	var secondSummary string
	if err := s.DB().QueryRow(
		`SELECT summary FROM agent_runs WHERE workflow_run_id = ? AND node_id = 'n2'`, runID).
		Scan(&secondSummary); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(secondSummary, "First") {
		t.Errorf("the second node did not see the first node's output:\n%s", secondSummary)
	}
}

func TestAFailedNodeStopsTheRun(t *testing.T) {
	// Continuing past a failure runs later nodes on a broken premise.
	r, s, runID := testRunner(t)
	r.AgentPath = fakeAgent(t, `exit 1`)

	g := graph.Graph{
		Nodes: []graph.Node{agent("n1", "Breaks"), agent("n2", "NeverRuns")},
		Edges: []graph.Edge{{ID: "e1", Source: "n1", Target: "n2"}},
	}
	r.RunWorkflow(context.Background(), runID, "wf1", g, t.TempDir(), nil)

	if got := runStatus(t, s, runID); got != "failed" {
		t.Fatalf("run status = %q, want failed", got)
	}
	var n int
	s.DB().QueryRow(`SELECT COUNT(*) FROM agent_runs WHERE workflow_run_id = ? AND node_id = 'n2'`, runID).Scan(&n)
	if n != 0 {
		t.Error("a node downstream of a failure was executed")
	}
}

func TestEveryStepIsTerminalWhenTheRunEnds(t *testing.T) {
	// A step left at 'running' with no process behind it makes the UI spin
	// forever on a run that is already over.
	r, s, runID := testRunner(t)
	r.AgentPath = fakeAgent(t, `exit 1`)
	g := graph.Graph{Nodes: []graph.Node{agent("n1", "Breaks")}}

	r.RunWorkflow(context.Background(), runID, "wf1", g, t.TempDir(), nil)

	rows, err := s.DB().Query(`SELECT status FROM workflow_step_runs WHERE workflow_run_id = ?`, runID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var status string
		rows.Scan(&status)
		if status == "running" || status == "queued" {
			t.Errorf("a step was left at %q after the run ended", status)
		}
	}
}

func TestAnEmptyGraphFailsWithAReason(t *testing.T) {
	r, s, runID := testRunner(t)
	r.RunWorkflow(context.Background(), runID, "wf1", graph.Graph{}, t.TempDir(), nil)

	if got := runStatus(t, s, runID); got != "failed" {
		t.Errorf("run status = %q, want failed", got)
	}
	var message string
	s.DB().QueryRow(
		`SELECT message FROM run_logs WHERE workflow_run_id = ? AND level = 'error' LIMIT 1`, runID).Scan(&message)
	if message == "" {
		t.Error("an empty graph failed with no explanation in the log")
	}
}

func TestAlreadyCompletedNodesAreNotReRun(t *testing.T) {
	// THE RESUME MECHANISM. A node whose latest step is already completed is
	// skipped and its summary folded back into context. Re-running it means an
	// agent that already wrote files writes them twice.
	r, s, runID := testRunner(t)
	r.AgentPath = fakeAgent(t, `echo "fresh run"`)

	// Pre-seed n1 as already completed, exactly as a suspended run would leave it.
	if _, err := s.DB().Exec(
		`INSERT INTO workflow_step_runs (id, workflow_run_id, node_id, node_type, status, completed_at)
		 VALUES ('s-done', ?, 'n1', 'specialistAgent', 'completed', '2026-01-01 00:00:00')`, runID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB().Exec(
		`INSERT INTO agent_runs (id, workflow_run_id, node_id, agent_name, agent_role, status, summary, completed_at)
		 VALUES ('s-done', ?, 'n1', 'First', 'reviewer', 'completed', 'EARLIER-FINDING', '2026-01-01 00:00:00')`,
		runID); err != nil {
		t.Fatal(err)
	}

	g := graph.Graph{
		Nodes: []graph.Node{agent("n1", "First"), agent("n2", "Second")},
		Edges: []graph.Edge{{ID: "e1", Source: "n1", Target: "n2"}},
	}
	r.RunWorkflow(context.Background(), runID, "wf1", g, t.TempDir(), nil)

	var n1Count int
	s.DB().QueryRow(
		`SELECT COUNT(*) FROM agent_runs WHERE workflow_run_id = ? AND node_id = 'n1'`, runID).Scan(&n1Count)
	if n1Count != 1 {
		t.Errorf("n1 has %d agent_runs rows — a completed node was re-run", n1Count)
	}
}

func TestTriggerInputReachesTheFirstNode(t *testing.T) {
	// The trigger value is the user's instruction. If it does not reach the
	// prompt the run ignores what the user actually asked for.
	r, _, runID := testRunner(t)
	r.AgentPath = fakeAgent(t, `echo "PROMPT: $@"`)

	g := graph.Graph{
		Nodes: []graph.Node{
			{ID: "t1", Type: "trigger", Data: graph.NodeData{Label: "Topic", FieldName: "topic"}},
			agent("n1", "Reviewer"),
		},
		Edges: []graph.Edge{{ID: "e1", Source: "t1", Target: "n1"}},
	}
	r.RunWorkflow(context.Background(), runID, "wf1", g, t.TempDir(),
		map[string]string{"topic": "review the auth module"})

	var summary string
	r.Store.DB().QueryRow(
		`SELECT summary FROM agent_runs WHERE workflow_run_id = ? AND node_id = 'n1'`, runID).Scan(&summary)
	if !strings.Contains(summary, "review the auth module") {
		t.Errorf("the trigger input never reached the agent prompt:\n%s", summary)
	}
	if !strings.Contains(summary, "Topic") {
		t.Errorf("the trigger value was not labelled, so the agent must guess its meaning:\n%s", summary)
	}
}

func TestCancellationStopsBeforeTheNextLevel(t *testing.T) {
	r, s, runID := testRunner(t)
	r.AgentPath = fakeAgent(t, `sleep 30`)

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		// Long enough for the first node to be in flight.
		for {
			var n int
			s.DB().QueryRow(`SELECT COUNT(*) FROM agent_runs WHERE workflow_run_id = ?`, runID).Scan(&n)
			if n > 0 {
				cancel()
				return
			}
		}
	}()

	g := graph.Graph{
		Nodes: []graph.Node{agent("n1", "Slow"), agent("n2", "Next")},
		Edges: []graph.Edge{{ID: "e1", Source: "n1", Target: "n2"}},
	}
	r.RunWorkflow(ctx, runID, "wf1", g, t.TempDir(), nil)

	if got := runStatus(t, s, runID); got != "cancelled" {
		t.Errorf("run status = %q, want cancelled", got)
	}
	var n2 int
	s.DB().QueryRow(`SELECT COUNT(*) FROM agent_runs WHERE workflow_run_id = ? AND node_id = 'n2'`, runID).Scan(&n2)
	if n2 != 0 {
		t.Error("the next level started after cancellation")
	}
}

func TestSiblingsBothRun(t *testing.T) {
	r, s, runID := testRunner(t)
	r.AgentPath = fakeAgent(t, `echo done`)

	g := graph.Graph{
		Nodes: []graph.Node{agent("a", "Root"), agent("b", "Left"), agent("c", "Right")},
		Edges: []graph.Edge{{ID: "e1", Source: "a", Target: "b"}, {ID: "e2", Source: "a", Target: "c"}},
	}
	r.RunWorkflow(context.Background(), runID, "wf1", g, t.TempDir(), nil)

	if got := runStatus(t, s, runID); got != "completed" {
		t.Fatalf("run status = %q", got)
	}
	var n int
	s.DB().QueryRow(`SELECT COUNT(*) FROM agent_runs WHERE workflow_run_id = ?`, runID).Scan(&n)
	if n != 3 {
		t.Errorf("%d nodes ran, want 3", n)
	}
}
