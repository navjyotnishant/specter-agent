package api

import (
	"fmt"

	"github.com/navjyotnishant/specter-agent/internal/graph"
)

// RecoverApprovedWaitingRuns restarts runs that were approved while nothing was
// executing.
//
// A gate blocks a goroutine, so a backend restart kills it. If the approval
// landed while the process was down, the run sits at waiting_approval with an
// APPROVED gate and nothing to notice — the most confusing stranding mode,
// because every row looks correct and the UI shows a granted approval on a dead
// run.
//
// Restarting from the top is safe: the run loop skips nodes whose latest step is
// already 'completed' and folds their summaries back into context, so execution
// walks straight back to the gate and continues past it.
//
// Called at startup, before serving. A run recovered after the first request
// would still have been stranded for however long that took.
func (d *Deps) RecoverApprovedWaitingRuns() int {
	rows, err := d.Store.DB().Query(
		`SELECT DISTINCT wr.id, wr.workflow_id, wr.graph_json, wr.workspace_path, wr.run_input_json
		   FROM workflow_runs wr
		   JOIN approval_requests ar ON ar.workflow_run_id = wr.id
		  WHERE wr.status = 'waiting_approval'
		    AND ar.status = 'approved'
		    AND wr.workspace_path IS NOT NULL
		    AND wr.workspace_path != ''`)
	if err != nil {
		return 0
	}
	defer rows.Close()

	type pending struct{ runID, workflowID, graphJSON, workspace, runInput string }
	var candidates []pending
	for rows.Next() {
		var p pending
		if err := rows.Scan(&p.runID, &p.workflowID, &p.graphJSON, &p.workspace, &p.runInput); err != nil {
			continue
		}
		candidates = append(candidates, p)
	}

	recovered := 0
	for _, p := range candidates {
		parsed, err := graph.Parse([]byte(p.graphJSON))
		if err != nil || len(parsed.Nodes) == 0 {
			// Logged rather than skipped silently: a run that cannot be
			// recovered is stuck, and someone has to be told which one.
			d.writeRunLog(p.runID, "error",
				fmt.Sprintf("Unable to recover approved approval gate: %v", err))
			continue
		}
		if d.isRunActive(p.runID) {
			continue
		}
		d.startExecution(p.runID, p.workflowID, *parsed, p.workspace, decodeRunInput(p.runInput))
		d.writeRunLog(p.runID, "info", "Recovered approved approval gate after app restart.")
		recovered++
	}
	return recovered
}

func (d *Deps) writeRunLog(runID, level, message string) {
	d.Store.DB().Exec(
		`INSERT INTO run_logs (workflow_run_id, level, message) VALUES (?, ?, ?)`,
		runID, level, message)
}
