// The approvals READ surface, run memory, and /api/health/system.
//
// Resolving an approval (approve / reject / request-revision) is deliberately
// absent: each one resumes the suspended run through graph_runner, ~950 lines
// that are not ported yet. An endpoint that recorded the decision without
// resuming would be worse than a 404 — it would report success while the run
// stayed suspended forever, and the UI would show an approved gate on a dead
// run.
package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"path/filepath"
	"time"

	"github.com/go-chi/chi/v5"
	"golang.org/x/sys/unix"
)

type approval struct {
	ID                string          `json:"id"`
	WorkflowRunID     string          `json:"workflow_run_id"`
	WorkflowStepRunID *string         `json:"workflow_step_run_id"`
	AgentRunID        *string         `json:"agent_run_id"`
	Status            string          `json:"status"`
	Title             string          `json:"title"`
	Reason            string          `json:"reason"`
	ProposedAction    json.RawMessage `json:"proposed_action"`
	ContextSummary    string          `json:"context_summary"`
	RequestedByAgent  *string         `json:"requested_by_agent"`
	ExpiresAt         *string         `json:"expires_at"`
	ResolvedByUserID  *string         `json:"resolved_by_user_id"`
	ResolvedAt        *string         `json:"resolved_at"`
	ResolutionComment *string         `json:"resolution_comment"`
	CreatedAt         string          `json:"created_at"`
}

const approvalColumns = `id, workflow_run_id, workflow_step_run_id, agent_run_id, status,
	title, reason, proposed_action_json, context_summary, requested_by_agent,
	expires_at, resolved_by_user_id, resolved_at, resolution_comment, created_at`

func scanApproval(row interface{ Scan(...any) error }) (approval, error) {
	var a approval
	var stepRun, agentRun, requestedBy, expires, resolvedBy, resolvedAt, comment sql.NullString
	var proposed string
	if err := row.Scan(&a.ID, &a.WorkflowRunID, &stepRun, &agentRun, &a.Status,
		&a.Title, &a.Reason, &proposed, &a.ContextSummary, &requestedBy,
		&expires, &resolvedBy, &resolvedAt, &comment, &a.CreatedAt); err != nil {
		return approval{}, err
	}
	if proposed == "" {
		proposed = "{}"
	}
	a.ProposedAction = json.RawMessage(proposed)
	for _, pair := range []struct {
		src sql.NullString
		dst **string
	}{{stepRun, &a.WorkflowStepRunID}, {agentRun, &a.AgentRunID},
		{requestedBy, &a.RequestedByAgent}, {expires, &a.ExpiresAt},
		{resolvedBy, &a.ResolvedByUserID}, {resolvedAt, &a.ResolvedAt},
		{comment, &a.ResolutionComment}} {
		if pair.src.Valid {
			value := pair.src.String
			*pair.dst = &value
		}
	}
	return a, nil
}

func (d *Deps) collectApprovals(rows *sql.Rows) ([]approval, error) {
	defer rows.Close()
	out := []approval{}
	for rows.Next() {
		a, err := scanApproval(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, nil
}

func (d *Deps) listApprovals(w http.ResponseWriter, r *http.Request) {
	query := `SELECT ` + approvalColumns + ` FROM approval_requests`
	var args []any
	if status := r.URL.Query().Get("status"); status != "" {
		query += ` WHERE status = ?`
		args = append(args, status)
	}
	query += ` ORDER BY created_at DESC`

	rows, err := d.Store.DB().Query(query, args...)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not list approvals")
		return
	}
	out, err := d.collectApprovals(rows)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not read approvals")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) getApproval(w http.ResponseWriter, r *http.Request) {
	a, err := scanApproval(d.Store.DB().QueryRow(
		`SELECT `+approvalColumns+` FROM approval_requests WHERE id = ?`,
		chi.URLParam(r, "approvalID")))
	if errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusNotFound, "Approval request not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not read the approval")
		return
	}
	writeJSON(w, http.StatusOK, a)
}

// runApprovals is scoped to one run — it must never leak another run's gates.
func (d *Deps) runApprovals(w http.ResponseWriter, r *http.Request) {
	// Expiry runs on READ. Any endpoint touching approvals may therefore mutate
	// state as a side effect -- that is deliberate: there is no scheduler, so a
	// deadline that passed while the backend was down is noticed the moment
	// somebody looks.
	d.expirePendingApprovals(chi.URLParam(r, "runID"))

	rows, err := d.Store.DB().Query(
		`SELECT `+approvalColumns+` FROM approval_requests
		  WHERE workflow_run_id = ? ORDER BY created_at DESC`,
		chi.URLParam(r, "runID"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not read approvals")
		return
	}
	out, err := d.collectApprovals(rows)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not read approvals")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// --- run memory ---

type memoryEntry struct {
	ID            string  `json:"id"`
	WorkflowRunID string  `json:"workflow_run_id"`
	AgentRunID    *string `json:"agent_run_id"`
	Scope         string  `json:"scope"`
	Key           string  `json:"key"`
	ValueText     string  `json:"value_text"`
	CreatedAt     string  `json:"created_at"`
}

func (d *Deps) runMemory(w http.ResponseWriter, r *http.Request) {
	query := `SELECT id, workflow_run_id, agent_run_id, scope, key, value_text, created_at
	            FROM memory_entries WHERE workflow_run_id = ?`
	args := []any{chi.URLParam(r, "runID")}
	if scope := r.URL.Query().Get("scope"); scope != "" {
		query += ` AND scope = ?`
		args = append(args, scope)
	}
	query += ` ORDER BY created_at ASC`

	rows, err := d.Store.DB().Query(query, args...)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not read memory")
		return
	}
	defer rows.Close()

	out := []memoryEntry{}
	for rows.Next() {
		var e memoryEntry
		var agentRun sql.NullString
		if err := rows.Scan(&e.ID, &e.WorkflowRunID, &agentRun, &e.Scope,
			&e.Key, &e.ValueText, &e.CreatedAt); err != nil {
			writeError(w, http.StatusInternalServerError, "Could not read memory")
			return
		}
		if agentRun.Valid {
			value := agentRun.String
			e.AgentRunID = &value
		}
		out = append(out, e)
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) clearRunMemory(w http.ResponseWriter, r *http.Request) {
	runID := chi.URLParam(r, "runID")
	res, err := d.Store.DB().Exec(`DELETE FROM memory_entries WHERE workflow_run_id = ?`, runID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not clear memory")
		return
	}
	n, _ := res.RowsAffected()
	writeJSON(w, http.StatusOK, map[string]any{"deleted": n, "run_id": runID})
}

// --- /api/health/system ---

// systemHealth samples real load, memory and disk.
//
// Every field here is read by the dashboard's runtime panel. A hardcoded
// "healthy" would mean the panel reports fine while the volume holding the
// database is full — which is the one moment the panel matters.
func (d *Deps) systemHealth(w http.ResponseWriter, _ *http.Request) {
	dbDir := filepath.Dir(d.DBPath)
	if dbDir == "" || dbDir == "." {
		dbDir = "/"
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"sampled_at": time.Now().UTC().Format(time.RFC3339),
		"load":       loadStatus(),
		"memory":     memoryStatus(),
		"disk":       diskStatus(dbDir),
	})
}

func diskStatus(path string) map[string]any {
	var stat unix.Statfs_t
	if err := unix.Statfs(path, &stat); err != nil {
		return map[string]any{
			"status": "unavailable", "path": path, "total_bytes": nil,
			"used_bytes": nil, "free_bytes": nil, "used_percent": nil,
			"message": "Disk metrics unavailable: " + err.Error(),
		}
	}
	blockSize := uint64(stat.Bsize)
	total := stat.Blocks * blockSize
	free := stat.Bavail * blockSize
	used := total - free

	var usedPercent any
	status := "healthy"
	if total > 0 {
		percent := roundTo1(float64(used) / float64(total) * 100)
		usedPercent = percent
		switch {
		case percent >= 92:
			status = "critical"
		case percent >= 80:
			status = "warning"
		}
	}
	return map[string]any{
		"status": status, "path": path,
		"total_bytes": total, "used_bytes": used, "free_bytes": free,
		"used_percent": usedPercent,
		"message":      "Disk usage sampled.",
	}
}

func roundTo2(value float64) float64 {
	return float64(int64(value*100+0.5)) / 100
}

func unavailableLoad(cpuCount int, message string) map[string]any {
	return map[string]any{
		"status": "unavailable", "load_1": nil, "load_5": nil, "load_15": nil,
		"cpu_count": cpuCount, "pressure_percent": nil, "message": message,
	}
}

func unavailableMemory() map[string]any {
	return map[string]any{
		"status": "unavailable", "total_bytes": nil, "used_bytes": nil,
		"available_bytes": nil, "used_percent": nil,
		"message": "Memory metrics are unavailable on this platform.",
	}
}
