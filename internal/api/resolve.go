package api

import (
	"database/sql"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/navjyotnishant/specter-agent/internal/graph"
	"github.com/navjyotnishant/specter-agent/internal/runner"
)

type resolutionRequest struct {
	UserID  string `json:"user_id"`
	Comment string `json:"comment"`
}

// resolveApproval answers a gate AND resumes the run.
//
// The second half is the part that is easy to omit and impossible to notice:
// marking the approval while nothing is executing leaves the run at
// waiting_approval forever, and the UI shows an APPROVED gate on a dead run.
// That is the most confusing stranding mode, because every row looks correct.
func (d *Deps) resolveApproval(status string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		runID := chi.URLParam(r, "runID")
		approvalID := chi.URLParam(r, "approvalID")

		var req resolutionRequest
		decode(r, &req) // a body is optional

		// Expire first, so a gate that is past its deadline cannot be answered
		// as though it were still open.
		d.expirePendingApprovals(runID)

		var current string
		err := d.Store.DB().QueryRow(
			`SELECT status FROM approval_requests WHERE id = ? AND workflow_run_id = ?`,
			approvalID, runID).Scan(&current)
		if errors.Is(err, sql.ErrNoRows) {
			// Scoped to the run: an approval belonging to a different run must
			// not resolve through this one.
			writeError(w, http.StatusNotFound, "Approval request not found.")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Could not read the approval")
			return
		}
		if current != "pending" {
			// A second click must not flip a rejection into an approval: the run
			// has already acted on the first answer.
			writeError(w, http.StatusBadRequest, "Approval already resolved: "+current)
			return
		}

		resolvedBy := req.UserID
		if resolvedBy == "" {
			if user := userFrom(r); user != nil {
				resolvedBy = user.ID
			}
		}
		var comment any
		if req.Comment != "" {
			comment = req.Comment
		}

		// Guarded on 'pending' so two reviewers clicking at once cannot both win.
		res, err := d.Store.DB().Exec(
			`UPDATE approval_requests
			    SET status = ?, resolved_by_user_id = ?, resolved_at = CURRENT_TIMESTAMP,
			        resolution_comment = ?
			  WHERE id = ? AND status = 'pending'`,
			status, resolvedBy, comment, approvalID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Could not resolve the approval")
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			writeError(w, http.StatusBadRequest, "Approval already resolved.")
			return
		}

		if status == "approved" {
			d.resumeRun(runID)
		} else {
			d.Store.DB().Exec(
				`UPDATE workflow_runs SET status = ? WHERE id = ? AND status = 'waiting_approval'`,
				status, runID)
		}

		approval, err := scanApproval(d.Store.DB().QueryRow(
			`SELECT `+approvalColumns+` FROM approval_requests WHERE id = ?`, approvalID))
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Could not read the resolved approval")
			return
		}
		writeJSON(w, http.StatusOK, approval)
	}
}

// resumeRun restarts a suspended run so it continues past the gate.
//
// Restarting from the top is safe and is how Python recovers too: the run loop
// skips nodes whose latest step is already 'completed' and folds their summaries
// back into context, so execution walks straight back to the gate — now
// approved — and continues. Nothing re-runs.
//
// A run already executing in this process is left alone: its blocked gate polls
// the row and will notice on its own. Restarting it would run the graph twice.
func (d *Deps) resumeRun(runID string) {
	d.Store.DB().Exec(
		`UPDATE workflow_runs SET status = 'running' WHERE id = ? AND status = 'waiting_approval'`, runID)

	if d.isRunActive(runID) {
		return
	}

	var workflowID, graphJSON, workspace, runInputJSON string
	if err := d.Store.DB().QueryRow(
		`SELECT workflow_id, graph_json, workspace_path, run_input_json
		   FROM workflow_runs WHERE id = ?`, runID).
		Scan(&workflowID, &graphJSON, &workspace, &runInputJSON); err != nil {
		return
	}
	if workspace == "" {
		// Without a workspace there is nothing to run against, and guessing one
		// would run an agent against the wrong repository.
		return
	}
	parsed, err := graph.Parse([]byte(graphJSON))
	if err != nil || len(parsed.Nodes) == 0 {
		return
	}
	d.startExecution(runID, workflowID, *parsed, workspace, decodeRunInput(runInputJSON))
}

// expirePendingApprovals resolves anything past its deadline.
//
// Runs on READ rather than on a timer: there is no scheduler to miss, and a
// backend that was down over the deadline still notices the moment anyone looks.
func (d *Deps) expirePendingApprovals(runID string) {
	rows, err := d.Store.DB().Query(
		`SELECT id, workflow_step_run_id, expires_at FROM approval_requests
		  WHERE workflow_run_id = ? AND status = 'pending' AND expires_at IS NOT NULL`, runID)
	if err != nil {
		return
	}
	type expired struct{ id, stepID string }
	var due []expired
	for rows.Next() {
		var id string
		var stepID sql.NullString
		var expiresAt string
		if err := rows.Scan(&id, &stepID, &expiresAt); err != nil {
			continue
		}
		deadline, err := runner.ParseTimestamp(expiresAt)
		if err != nil || deadline.After(time.Now().UTC()) {
			continue
		}
		due = append(due, expired{id: id, stepID: stepID.String})
	}
	rows.Close()
	if len(due) == 0 {
		return
	}

	stamp := time.Now().UTC().Format("2006-01-02 15:04:05")
	for _, item := range due {
		d.Store.DB().Exec(
			`UPDATE approval_requests SET status = 'expired', resolved_at = ?
			  WHERE id = ? AND status = 'pending'`, stamp, item.id)
		if item.stepID != "" {
			d.Store.DB().Exec(
				`UPDATE workflow_step_runs SET status = 'cancelled', completed_at = ? WHERE id = ?`,
				stamp, item.stepID)
			d.Store.DB().Exec(
				`UPDATE agent_runs SET status = 'cancelled', completed_at = ?, error = ? WHERE id = ?`,
				stamp, "Approval expired without response.", item.stepID)
		}
	}
	// An expired gate cancels its run: nothing went wrong, nobody answered.
	d.Store.DB().Exec(
		`UPDATE workflow_runs SET status = 'cancelled', completed_at = ?
		  WHERE id = ? AND status = 'waiting_approval'`, stamp, runID)
}

func decodeRunInput(raw string) map[string]string {
	out := map[string]string{}
	if raw == "" {
		return out
	}
	jsonUnmarshalInto(raw, &out)
	return out
}

// resolveApprovalByID answers a gate found by its own id, with no run in the
// path.
//
// The run is looked up from the approval rather than trusted from the URL, so
// this shares every guard the run-scoped route has — expiry, the pending check,
// and the resume. A second implementation that only marked the row would strand
// runs resolved through this path while the other path worked fine, which is
// the kind of split-brain bug that takes days to see.
func (d *Deps) resolveApprovalByID(status string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		approvalID := chi.URLParam(r, "approvalID")

		var runID string
		if err := d.Store.DB().QueryRow(
			`SELECT workflow_run_id FROM approval_requests WHERE id = ?`, approvalID).Scan(&runID); err != nil {
			writeError(w, http.StatusNotFound, "Approval request not found.")
			return
		}

		// Re-enter the run-scoped handler with the run it belongs to.
		routeCtx := chi.RouteContext(r.Context())
		routeCtx.URLParams.Add("runID", runID)
		d.resolveApproval(status)(w, r)
	}
}
