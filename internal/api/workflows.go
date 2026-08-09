// Handlers for /api/workflows, ported from backend/app/runtime/workflows.py.
package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

type workflowRequest struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Graph       json.RawMessage `json:"graph"`
	// A pointer so "absent" is distinguishable from "empty string". Absent means
	// leave it alone; the template-publish and planner paths do not manage the
	// workspace and must not blank it.
	WorkspacePath *string `json:"workspace_path"`
}

// workflow is the wire shape. graph is decoded, not a JSON string — the builder
// renders it directly.
type workflow struct {
	ID            string          `json:"id"`
	Name          string          `json:"name"`
	Description   string          `json:"description"`
	Graph         json.RawMessage `json:"graph"`
	IsTemplate    bool            `json:"is_template"`
	WorkspacePath string          `json:"workspace_path"`
	CreatedAt     string          `json:"created_at"`
	UpdatedAt     string          `json:"updated_at"`
}

func (d *Deps) scanWorkflow(row interface{ Scan(...any) error }) (workflow, error) {
	var w workflow
	var graphJSON string
	var isTemplate int
	var workspacePath sql.NullString
	if err := row.Scan(&w.ID, &w.Name, &w.Description, &graphJSON, &isTemplate,
		&w.CreatedAt, &w.UpdatedAt, &workspacePath); err != nil {
		return workflow{}, err
	}
	if graphJSON == "" {
		graphJSON = "{}"
	}
	w.Graph = json.RawMessage(graphJSON)
	w.IsTemplate = isTemplate != 0
	w.WorkspacePath = workspacePath.String
	return w, nil
}

const workflowColumns = `id, name, description, graph_json, is_template, created_at, updated_at, workspace_path`

func (d *Deps) getWorkflowByID(id string) (workflow, error) {
	return d.scanWorkflow(d.Store.DB().QueryRow(
		`SELECT `+workflowColumns+` FROM workflows WHERE id = ?`, id))
}

func (d *Deps) listWorkflows(w http.ResponseWriter, _ *http.Request) {
	rows, err := d.Store.DB().Query(
		`SELECT ` + workflowColumns + ` FROM workflows ORDER BY created_at DESC`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not list workflows")
		return
	}
	defer rows.Close()

	out := []workflow{} // never nil: the client does .map() over this
	for rows.Next() {
		wf, err := d.scanWorkflow(rows)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Could not read workflows")
			return
		}
		out = append(out, wf)
	}
	writeJSON(w, http.StatusOK, out)
}

// rejectDuplicateName enforces case-insensitive uniqueness.
//
// Workflows are chosen BY NAME — in the list, and by name from the Telegram bot
// — so two that differ only in case are ambiguous at the point of use. The
// exclusion of the row being written is what lets a workflow be saved under its
// own name.
func (d *Deps) rejectDuplicateName(name, excludeID string) error {
	var clash string
	err := d.Store.DB().QueryRow(
		`SELECT id FROM workflows WHERE LOWER(name) = LOWER(?) AND id != ?`,
		strings.TrimSpace(name), excludeID).Scan(&clash)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	return errors.New("A workflow named '" + strings.TrimSpace(name) + "' already exists.")
}

func normalizeGraph(raw json.RawMessage) string {
	if len(raw) == 0 {
		return "{}"
	}
	return string(raw)
}

func (d *Deps) createWorkflow(w http.ResponseWriter, r *http.Request) {
	var req workflowRequest
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		writeError(w, http.StatusBadRequest, "Name is required")
		return
	}
	if len(name) > 160 {
		writeError(w, http.StatusBadRequest, "Name must be 160 characters or fewer")
		return
	}

	id := uuid.NewString()
	if err := d.rejectDuplicateName(name, id); err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}

	workspace := ""
	if req.WorkspacePath != nil {
		workspace = *req.WorkspacePath
	}
	if _, err := d.Store.DB().Exec(
		`INSERT INTO workflows (id, name, description, graph_json, workspace_path, is_template)
		 VALUES (?, ?, ?, ?, ?, 0)`,
		id, name, req.Description, normalizeGraph(req.Graph), workspace); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not create the workflow")
		return
	}

	wf, err := d.getWorkflowByID(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not read the new workflow")
		return
	}
	writeJSON(w, http.StatusOK, wf)
}

func (d *Deps) getWorkflow(w http.ResponseWriter, r *http.Request) {
	wf, err := d.getWorkflowByID(chi.URLParam(r, "workflowID"))
	if errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusNotFound, "Workflow not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not read the workflow")
		return
	}
	writeJSON(w, http.StatusOK, wf)
}

func (d *Deps) updateWorkflow(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "workflowID")
	var req workflowRequest
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		writeError(w, http.StatusBadRequest, "Name is required")
		return
	}
	if err := d.rejectDuplicateName(name, id); err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}

	// COALESCE, not a plain assignment: a nil workspace_path means "unchanged".
	// Blanking it would erase the only source a trigger-started run has for its
	// repository — there is no UI dropdown on that path to fall back to.
	var workspace any
	if req.WorkspacePath != nil && *req.WorkspacePath != "" {
		workspace = *req.WorkspacePath
	}
	res, err := d.Store.DB().Exec(
		`UPDATE workflows
		    SET name = ?, description = ?, graph_json = ?,
		        workspace_path = COALESCE(?, workspace_path),
		        updated_at = CURRENT_TIMESTAMP
		  WHERE id = ?`,
		name, req.Description, normalizeGraph(req.Graph), workspace, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not update the workflow")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeError(w, http.StatusNotFound, "Workflow not found")
		return
	}

	wf, err := d.getWorkflowByID(id)
	if err != nil {
		writeError(w, http.StatusNotFound, "Workflow not found")
		return
	}
	writeJSON(w, http.StatusOK, wf)
}

func (d *Deps) setTemplateFlag(isTemplate bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "workflowID")
		flag := 0
		if isTemplate {
			flag = 1
		}
		res, err := d.Store.DB().Exec(
			`UPDATE workflows SET is_template = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
			flag, id)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Could not update the workflow")
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			writeError(w, http.StatusNotFound, "Workflow not found")
			return
		}
		wf, err := d.getWorkflowByID(id)
		if err != nil {
			writeError(w, http.StatusNotFound, "Workflow not found")
			return
		}
		writeJSON(w, http.StatusOK, wf)
	}
}

// deleteWorkflow removes the workflow and everything hanging off its runs.
//
// SQLite foreign keys are not enforced on the Python connection and no child
// table declares ON DELETE CASCADE, so deleting only the workflows row strands
// run history, step runs, logs, agent messages, memory entries and approval
// requests — rows with no owner and no UI that can reach them.
//
// Children go first so a failure part-way through never leaves a workflow row
// pointing at rows already removed. Templates are protected by the WHERE clause
// on the DELETE itself rather than a pre-check, so a race cannot slip past it.
func (d *Deps) deleteWorkflow(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "workflowID")

	tx, err := d.Store.DB().Begin()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not delete the workflow")
		return
	}
	defer tx.Rollback()

	var protected string
	if err := tx.QueryRow(
		`SELECT id FROM workflows WHERE id = ? AND is_template = 0`, id).Scan(&protected); err != nil {
		// Missing or a template: report the outcome rather than erroring, which
		// is what the Python route does.
		writeJSON(w, http.StatusOK, map[string]any{"deleted": false, "workflow_id": id})
		return
	}

	rows, err := tx.Query(`SELECT id FROM workflow_runs WHERE workflow_id = ?`, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not read run history")
		return
	}
	var runIDs []any
	for rows.Next() {
		var runID string
		if err := rows.Scan(&runID); err != nil {
			rows.Close()
			writeError(w, http.StatusInternalServerError, "Could not read run history")
			return
		}
		runIDs = append(runIDs, runID)
	}
	rows.Close()

	if len(runIDs) > 0 {
		placeholders := strings.TrimSuffix(strings.Repeat("?,", len(runIDs)), ",")

		agentRows, err := tx.Query(
			`SELECT id FROM agent_runs WHERE workflow_run_id IN (`+placeholders+`)`, runIDs...)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Could not read agent runs")
			return
		}
		var agentRunIDs []any
		for agentRows.Next() {
			var agentRunID string
			agentRows.Scan(&agentRunID)
			agentRunIDs = append(agentRunIDs, agentRunID)
		}
		agentRows.Close()

		// Deepest first: agent_messages -> agent_runs -> run-scoped tables.
		if len(agentRunIDs) > 0 {
			ap := strings.TrimSuffix(strings.Repeat("?,", len(agentRunIDs)), ",")
			if _, err := tx.Exec(
				`DELETE FROM agent_messages WHERE agent_run_id IN (`+ap+`)`, agentRunIDs...); err != nil {
				writeError(w, http.StatusInternalServerError, "Could not delete agent messages")
				return
			}
		}
		for _, table := range []string{
			"approval_requests", "memory_entries", "agent_runs", "run_logs", "workflow_step_runs",
		} {
			if _, err := tx.Exec(
				`DELETE FROM `+table+` WHERE workflow_run_id IN (`+placeholders+`)`, runIDs...); err != nil {
				writeError(w, http.StatusInternalServerError, "Could not delete "+table)
				return
			}
		}
		if _, err := tx.Exec(
			`DELETE FROM workflow_runs WHERE id IN (`+placeholders+`)`, runIDs...); err != nil {
			writeError(w, http.StatusInternalServerError, "Could not delete runs")
			return
		}
	}

	res, err := tx.Exec(`DELETE FROM workflows WHERE id = ? AND is_template = 0`, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not delete the workflow")
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not commit the deletion")
		return
	}
	n, _ := res.RowsAffected()
	writeJSON(w, http.StatusOK, map[string]any{"deleted": n > 0, "workflow_id": id})
}
