// Handlers for the /api/workflow-runs READ surface, ported from
// backend/app/routers/runs.py.
//
// Starting a run and resolving an approval both resume execution through the
// engine and are not here — they need internal/exec wired in, and half a start
// endpoint is worse than none.
package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
)

type run struct {
	ID            string          `json:"id"`
	WorkflowID    string          `json:"workflow_id"`
	Status        string          `json:"status"`
	TriggerType   *string         `json:"trigger_type"`
	WorkspacePath *string         `json:"workspace_path"`
	Graph         json.RawMessage `json:"graph"`
	FinalReport   *string         `json:"final_report"`
	CreatedAt     string          `json:"created_at"`
	CompletedAt   *string         `json:"completed_at"`
}

const runColumns = `id, workflow_id, status, trigger_type, workspace_path, graph_json, final_report, created_at, completed_at`

func scanRun(row interface{ Scan(...any) error }) (run, error) {
	var r run
	var trigger, workspace, report, completed sql.NullString
	var graphJSON sql.NullString
	if err := row.Scan(&r.ID, &r.WorkflowID, &r.Status, &trigger, &workspace,
		&graphJSON, &report, &r.CreatedAt, &completed); err != nil {
		return run{}, err
	}
	graph := graphJSON.String
	if graph == "" {
		graph = "{}"
	}
	r.Graph = json.RawMessage(graph)
	for _, pair := range []struct {
		src sql.NullString
		dst **string
	}{{trigger, &r.TriggerType}, {workspace, &r.WorkspacePath}, {report, &r.FinalReport}, {completed, &r.CompletedAt}} {
		if pair.src.Valid {
			value := pair.src.String
			*pair.dst = &value
		}
	}
	return r, nil
}

// clampInt keeps a caller-supplied bound inside a sane range rather than
// rejecting it — the UI passes these straight through.
func clampInt(raw string, fallback, min, max int) int {
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

// listRuns returns recent runs, newest first.
//
// The limit is a caller-visible parameter rather than a hidden 20: callers were
// treating the truncated page as a total, so a dashboard tile froze at 20 once
// the 21st run existed. Anything wanting real totals uses /stats.
func (d *Deps) listRuns(w http.ResponseWriter, r *http.Request) {
	limit := clampInt(r.URL.Query().Get("limit"), 100, 1, 500)
	workflowID := r.URL.Query().Get("workflow_id")

	var rows *sql.Rows
	var err error
	if workflowID != "" {
		rows, err = d.Store.DB().Query(
			`SELECT `+runColumns+` FROM workflow_runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT ?`,
			workflowID, limit)
	} else {
		rows, err = d.Store.DB().Query(
			`SELECT `+runColumns+` FROM workflow_runs ORDER BY created_at DESC LIMIT ?`, limit)
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not list runs")
		return
	}
	defer rows.Close()

	out := []run{}
	for rows.Next() {
		item, err := scanRun(rows)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Could not read runs")
			return
		}
		out = append(out, item)
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) getRun(w http.ResponseWriter, r *http.Request) {
	item, err := scanRun(d.Store.DB().QueryRow(
		`SELECT `+runColumns+` FROM workflow_runs WHERE id = ?`, chi.URLParam(r, "runID")))
	if errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusNotFound, "Run not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not read the run")
		return
	}
	writeJSON(w, http.StatusOK, item)
}

type runStep struct {
	ID          string  `json:"id"`
	NodeID      string  `json:"node_id"`
	NodeType    string  `json:"node_type"`
	AgentName   *string `json:"agent_name"`
	AgentRole   *string `json:"agent_role"`
	Status      string  `json:"status"`
	Summary     *string `json:"summary"`
	Error       *string `json:"error"`
	StartedAt   *string `json:"started_at"`
	CompletedAt *string `json:"completed_at"`
}

// runSteps reads from agent_runs, NOT workflow_step_runs.
//
// The UI's notion of a "step" is the agent run: agent_name, agent_role, summary
// and error all live there. workflow_step_runs contributes only node_type, and
// the two share an id (ws.id = ar.id) rather than being related by a foreign
// key — which is why this is a LEFT JOIN on the primary key and not a lookup.
func (d *Deps) runSteps(w http.ResponseWriter, r *http.Request) {
	rows, err := d.Store.DB().Query(
		`SELECT ar.id, ar.node_id, COALESCE(ws.node_type, '') AS node_type,
		        ar.agent_name, ar.agent_role, ar.status, ar.summary, ar.error,
		        ar.started_at, ar.completed_at
		   FROM agent_runs ar
		   LEFT JOIN workflow_step_runs ws ON ws.id = ar.id
		  WHERE ar.workflow_run_id = ?
		  ORDER BY ar.started_at ASC`,
		chi.URLParam(r, "runID"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not read steps")
		return
	}
	defer rows.Close()

	out := []runStep{}
	for rows.Next() {
		var s runStep
		var agentName, agentRole, summary, errText, startedAt, completedAt sql.NullString
		if err := rows.Scan(&s.ID, &s.NodeID, &s.NodeType, &agentName, &agentRole,
			&s.Status, &summary, &errText, &startedAt, &completedAt); err != nil {
			writeError(w, http.StatusInternalServerError, "Could not read steps")
			return
		}
		for _, pair := range []struct {
			src sql.NullString
			dst **string
		}{{agentName, &s.AgentName}, {agentRole, &s.AgentRole}, {summary, &s.Summary},
			{errText, &s.Error}, {startedAt, &s.StartedAt}, {completedAt, &s.CompletedAt}} {
			if pair.src.Valid {
				value := pair.src.String
				*pair.dst = &value
			}
		}
		out = append(out, s)
	}
	writeJSON(w, http.StatusOK, out)
}

type runLog struct {
	ID        string          `json:"id"`
	Level     string          `json:"level"`
	Message   string          `json:"message"`
	Metadata  json.RawMessage `json:"metadata"`
	CreatedAt string          `json:"created_at"`
}

func (d *Deps) runLogs(w http.ResponseWriter, r *http.Request) {
	rows, err := d.Store.DB().Query(
		`SELECT id, level, message, metadata_json, created_at
		   FROM run_logs WHERE workflow_run_id = ? ORDER BY created_at`,
		chi.URLParam(r, "runID"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not read logs")
		return
	}
	defer rows.Close()

	out := []runLog{}
	for rows.Next() {
		var entry runLog
		var id, level sql.NullString
		var metadata sql.NullString
		if err := rows.Scan(&id, &level, &entry.Message, &metadata, &entry.CreatedAt); err != nil {
			writeError(w, http.StatusInternalServerError, "Could not read logs")
			return
		}
		entry.ID = id.String
		entry.Level = level.String
		// The column is metadata_json; the field is metadata, decoded.
		raw := metadata.String
		if raw == "" {
			raw = "{}"
		}
		entry.Metadata = json.RawMessage(raw)
		out = append(out, entry)
	}
	writeJSON(w, http.StatusOK, out)
}

type agentMessage struct {
	ID         string `json:"id"`
	AgentRunID string `json:"agent_run_id"`
	SenderType string `json:"sender_type"`
	SenderName string `json:"sender_name"`
	Content    string `json:"content"`
	CreatedAt  string `json:"created_at"`
}

// stepMessages returns the messages for one step. The step id IS the agent run
// id (see runSteps), so this filters on agent_run_id directly rather than
// joining back through the run.
func (d *Deps) stepMessages(w http.ResponseWriter, r *http.Request) {
	rows, err := d.Store.DB().Query(
		`SELECT id, agent_run_id, sender_type, sender_name, content, created_at
		   FROM agent_messages WHERE agent_run_id = ? ORDER BY created_at ASC`,
		chi.URLParam(r, "stepID"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not read messages")
		return
	}
	defer rows.Close()

	out := []agentMessage{}
	for rows.Next() {
		var m agentMessage
		if err := rows.Scan(&m.ID, &m.AgentRunID, &m.SenderType, &m.SenderName,
			&m.Content, &m.CreatedAt); err != nil {
			writeError(w, http.StatusInternalServerError, "Could not read messages")
			return
		}
		out = append(out, m)
	}
	writeJSON(w, http.StatusOK, out)
}

// runStats computes aggregates in SQL over the whole table rather than over a
// page of it. Counting from a truncated list is how the attention banner could
// report "All clear" while failures sat just outside the loaded window.
func (d *Deps) runStats(w http.ResponseWriter, r *http.Request) {
	windowHours := clampInt(r.URL.Query().Get("window_hours"), 24, 1, 24*30)
	since := fmt.Sprintf("-%d hours", windowHours)

	var total, failed, completed int
	err := d.Store.DB().QueryRow(
		`SELECT COUNT(*),
		        COALESCE(SUM(status = 'failed'), 0),
		        COALESCE(SUM(status = 'completed'), 0)
		   FROM workflow_runs WHERE created_at >= datetime('now', ?)`, since).
		Scan(&total, &failed, &completed)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not compute stats")
		return
	}

	// Active is counted with NO window: a run started two days ago and still
	// going is exactly what an operator needs to see.
	var active, waiting int
	d.Store.DB().QueryRow(
		`SELECT COUNT(*) FROM workflow_runs WHERE status IN ('running','queued','waiting_approval')`).Scan(&active)
	d.Store.DB().QueryRow(
		`SELECT COUNT(*) FROM workflow_runs WHERE status = 'waiting_approval'`).Scan(&waiting)

	// Oldest thing still running. "3 running" says nothing about whether one has
	// been stuck for an hour, which is the question an operator actually has.
	var oldest sql.NullString
	d.Store.DB().QueryRow(
		`SELECT MIN(created_at) FROM workflow_runs
		  WHERE status IN ('running','queued','waiting_approval')`).Scan(&oldest)

	currentMedian := d.medianDuration(since, "")
	// The same median over the PREVIOUS window, so the tile shows a direction
	// rather than a bare number.
	previousMedian := d.medianDuration(fmt.Sprintf("-%d hours", windowHours*2), since)

	body := map[string]any{
		"total": total, "failed": failed, "completed": completed,
		"active": active, "waiting_approval": waiting,
		"oldest_active_started_at":         nullableString(oldest),
		"median_duration_seconds":          currentMedian,
		"previous_median_duration_seconds": previousMedian,
		// Null unless BOTH windows have data. Guarding only the previous window
		// let an EMPTY current window report "81s faster" — a trend computed
		// against nothing, which is the same invention the guard exists to stop,
		// just from the other side.
		"median_delta_seconds": nil,
	}
	if currentMedian != nil && previousMedian != nil {
		delta := *currentMedian - *previousMedian
		body["median_delta_seconds"] = roundTo1(delta)
	}
	writeJSON(w, http.StatusOK, body)
}

// medianDuration is the true median, not the mean: one 40-minute outlier drags
// an average somewhere no actual run has ever been. The LIMIT/OFFSET pair is
// the standard SQLite median — LIMIT 2 minus the parity of the count picks one
// row for an odd count and two for an even one, and AVG then averages them.
func (d *Deps) medianDuration(since, until string) *float64 {
	where := `completed_at IS NOT NULL AND created_at >= datetime('now', ?)`
	args := []any{since}
	if until != "" {
		where += ` AND created_at < datetime('now', ?)`
		args = append(args, until)
	}

	query := `
		SELECT AVG(secs) FROM (
		  SELECT (julianday(completed_at) - julianday(created_at)) * 86400 AS secs
		    FROM workflow_runs WHERE ` + where + `
		   ORDER BY secs
		   LIMIT 2 - (SELECT COUNT(*) FROM workflow_runs WHERE ` + where + `) % 2
		  OFFSET (SELECT (COUNT(*) - 1) / 2 FROM workflow_runs WHERE ` + where + `)
		)`
	full := append(append(append([]any{}, args...), args...), args...)

	var median sql.NullFloat64
	if err := d.Store.DB().QueryRow(query, full...).Scan(&median); err != nil || !median.Valid {
		return nil
	}
	value := roundTo1(median.Float64)
	return &value
}

func roundTo1(value float64) float64 {
	return float64(int64(value*10+0.5)) / 10
}

func nullableString(value sql.NullString) any {
	if !value.Valid {
		return nil
	}
	return value.String
}
