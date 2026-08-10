package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

// cancelRunHandler stops a run.
//
// Two halves, and both are needed:
//
//  1. Kill the agent if this process is the one running it. Python cannot do
//     this — it marks the row and the loop notices between nodes, so the
//     subprocess keeps working in the meantime. A run marked cancelled whose
//     agent is still editing files is a lie the UI tells.
//
//  2. Mark the row regardless. The run may be in flight in a DIFFERENT process
//     — the Python backend, or another `specter serve` against the same
//     database — where this one has nothing to kill. The status guard is what
//     that other process reads to stop.
//
// The WHERE clause restricts the update to non-terminal states: a completed run
// that later reported "cancelled" would rewrite history, denying work that
// actually happened.
func (d *Deps) cancelRunHandler(w http.ResponseWriter, r *http.Request) {
	runID := chi.URLParam(r, "runID")

	d.cancelRun(runID)

	if _, err := d.Store.DB().Exec(
		`UPDATE workflow_runs
		    SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP
		  WHERE id = ? AND status IN ('queued','running','waiting_approval')`,
		runID); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not cancel the run")
		return
	}

	// Reported as cancelled even when nothing was in flight: cancelling
	// something already finished is the caller getting what they asked for.
	writeJSON(w, http.StatusOK, map[string]any{"cancelled": true, "run_id": runID})
}
