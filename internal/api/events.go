package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
)

// runEvents streams a run's progress as server-sent events.
//
// Python emitted four CANNED events describing a demo that no longer runs. This
// streams the real run: steps as they change state, and a terminal event when
// the run finishes. Same transport, same event names where they still mean
// something, but the data is now true.
//
// Polling the database is deliberate. The alternative is an in-process event
// bus, which would only see runs executing in THIS process — and during cutover
// a run may be executing elsewhere against the same database. Polling sees both.
func (d *Deps) runEvents(w http.ResponseWriter, r *http.Request) {
	runID := chi.URLParam(r, "runID")

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "Streaming is not supported here")
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	// Without this an intermediate proxy buffers the whole stream and the
	// client sees nothing until the run ends, which defeats the point.
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	send := func(event string, payload map[string]any) {
		body, _ := json.Marshal(payload)
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, body)
		flusher.Flush()
	}

	var status string
	if err := d.Store.DB().QueryRow(
		`SELECT status FROM workflow_runs WHERE id = ?`, runID).Scan(&status); err != nil {
		send("error", map[string]any{"run_id": runID, "message": "Run not found."})
		return
	}
	send("run_status", map[string]any{"run_id": runID, "status": status})

	seen := map[string]string{}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()

	// Bounded. A browser tab left open on a finished run should not hold a
	// connection and a goroutine indefinitely.
	deadline := time.After(30 * time.Minute)

	for {
		select {
		case <-r.Context().Done():
			// The client disconnected — stop immediately rather than polling
			// for a reader that is gone.
			return
		case <-deadline:
			send("stream_closed", map[string]any{"run_id": runID, "reason": "timeout"})
			return
		case <-ticker.C:
		}

		rows, err := d.Store.DB().Query(
			`SELECT id, agent_name, status, COALESCE(summary,''), COALESCE(error,'')
			   FROM agent_runs WHERE workflow_run_id = ? ORDER BY started_at`, runID)
		if err != nil {
			continue
		}
		for rows.Next() {
			var id, name, stepStatus, summary, errText string
			if rows.Scan(&id, &name, &stepStatus, &summary, &errText) != nil {
				continue
			}
			if seen[id] == stepStatus {
				continue
			}
			seen[id] = stepStatus
			send("agent_step", map[string]any{
				"run_id": runID, "step_id": id, "agent": name,
				"status": stepStatus, "summary": summary, "error": errText,
			})
		}
		rows.Close()

		var current string
		if d.Store.DB().QueryRow(`SELECT status FROM workflow_runs WHERE id = ?`, runID).
			Scan(&current) != nil {
			return
		}
		if current != status {
			status = current
			send("run_status", map[string]any{"run_id": runID, "status": status})
		}
		switch status {
		case "completed", "failed", "cancelled":
			send("run_finished", map[string]any{"run_id": runID, "status": status})
			return
		case "waiting_approval":
			// Named as Python named it: the UI already listens for this.
			send("approval_required", map[string]any{
				"run_id": runID, "reason": "This run is waiting for human approval."})
		}
	}
}
