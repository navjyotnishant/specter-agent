package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/google/uuid"

	"github.com/navjyotnishant/specter-agent/internal/graph"
	"github.com/navjyotnishant/specter-agent/internal/runner"
)

type startRunRequest struct {
	WorkflowID string `json:"workflow_id"`
	// Blank falls back to the workflow's OWN workspace. A Telegram message
	// carries no workspace, and the UI already picks one per run.
	WorkspacePath string            `json:"workspace_path"`
	Graph         json.RawMessage   `json:"graph"`
	RunInput      map[string]string `json:"run_input"`
	TriggerType   string            `json:"trigger_type"`
}

// approvedWorkspace resolves a requested path against the active workspace
// allowlist, or explains why it is refused.
//
// FAILS CLOSED at every step: an empty path, no approved roots, or a path
// outside all of them is a refusal. "Not provisioned" is not permission.
//
// Both sides are resolved through EvalSymlinks before comparison. Without it a
// symlink inside an approved root points anywhere on the filesystem, and on
// macOS /tmp resolves to /private/tmp so honest paths fail to match. The
// separator in the prefix check is load-bearing too: /repos/app must permit
// /repos/app/src but not /repos/app-secrets, which is a different directory
// that merely shares a string prefix.
func (d *Deps) approvedWorkspace(requested string) (string, error) {
	if strings.TrimSpace(requested) == "" {
		return "", errors.New("Workspace path is required.")
	}
	resolved := resolvePath(requested)

	rows, err := d.Store.DB().Query(`SELECT path FROM runtime_workspaces WHERE is_active = 1`)
	if err != nil {
		return "", errors.New("Could not read the approved workspace list.")
	}
	defer rows.Close()

	// Longest match wins, so a nested approved root is preferred over its
	// parent — matching Python, which sorts candidates by path depth.
	var matches []string
	for rows.Next() {
		var approved string
		if err := rows.Scan(&approved); err != nil {
			continue
		}
		root := resolvePath(approved)
		if resolved == root || strings.HasPrefix(resolved, root+string(filepath.Separator)) {
			matches = append(matches, root)
		}
	}
	if len(matches) == 0 {
		return "", errors.New("Workspace path is not approved for workflow execution.")
	}
	sort.Slice(matches, func(i, j int) bool { return len(matches[i]) > len(matches[j]) })
	return resolved, nil
}

func resolvePath(path string) string {
	expanded := path
	if strings.HasPrefix(expanded, "~") {
		if home, err := homeDir(); err == nil {
			expanded = filepath.Join(home, strings.TrimPrefix(expanded, "~"))
		}
	}
	if resolved, err := filepath.EvalSymlinks(expanded); err == nil {
		expanded = resolved
	}
	absolute, err := filepath.Abs(expanded)
	if err != nil {
		return filepath.Clean(expanded)
	}
	return absolute
}

// startRun creates the run row and starts execution in the background.
//
// The row exists before this returns. A caller that had to poll for a run that
// did not exist yet could not tell "starting" from "rejected".
func (d *Deps) startRun(w http.ResponseWriter, r *http.Request) {
	var req startRunRequest
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if strings.TrimSpace(req.WorkflowID) == "" {
		writeError(w, http.StatusBadRequest, "workflow_id is required")
		return
	}

	var savedWorkspace sql.NullString
	var savedGraph string
	switch err := d.Store.DB().QueryRow(
		`SELECT workspace_path, graph_json FROM workflows WHERE id = ?`, req.WorkflowID).
		Scan(&savedWorkspace, &savedGraph); {
	case errors.Is(err, sql.ErrNoRows):
		writeError(w, http.StatusNotFound, "Workflow not found.")
		return
	case err != nil:
		writeError(w, http.StatusInternalServerError, "Could not read the workflow")
		return
	}

	workspace := strings.TrimSpace(req.WorkspacePath)
	if workspace == "" {
		// The workflow's OWN workspace, never a global default: running workflow
		// A against workflow B's repo would write to the wrong tree.
		workspace = strings.TrimSpace(savedWorkspace.String)
		if workspace == "" {
			writeError(w, http.StatusBadRequest,
				"This workflow has no workspace set. Open it in the builder, pick a repository, and save.")
			return
		}
	}

	approved, err := d.approvedWorkspace(workspace)
	if err != nil {
		writeError(w, http.StatusForbidden, err.Error())
		return
	}

	// An explicitly supplied graph wins — the builder can run unsaved edits.
	graphJSON := savedGraph
	if len(req.Graph) > 0 && string(req.Graph) != "null" && string(req.Graph) != "{}" {
		graphJSON = string(req.Graph)
	}
	parsed, err := graph.Parse([]byte(graphJSON))
	if err != nil {
		writeError(w, http.StatusBadRequest, "This workflow's graph could not be read: "+err.Error())
		return
	}
	if len(parsed.Nodes) == 0 {
		writeError(w, http.StatusBadRequest, "This workflow has no nodes.")
		return
	}

	triggerType := strings.TrimSpace(req.TriggerType)
	if triggerType == "" {
		triggerType = "manual"
	}
	runInput := req.RunInput
	if runInput == nil {
		runInput = map[string]string{}
	}
	encodedInput, _ := json.Marshal(runInput)

	runID := uuid.NewString()
	if _, err := d.Store.DB().Exec(
		`INSERT INTO workflow_runs (id, workflow_id, status, trigger_type, graph_json, workspace_path, run_input_json)
		 VALUES (?, ?, 'queued', ?, ?, ?, ?)`,
		runID, req.WorkflowID, triggerType, graphJSON, approved, string(encodedInput)); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not create the run")
		return
	}

	// Remember it, so a trigger-started run uses the same repo the UI last ran
	// against.
	d.Store.DB().Exec(`UPDATE workflows SET workspace_path = ? WHERE id = ?`, approved, req.WorkflowID)

	d.startExecution(runID, req.WorkflowID, *parsed, approved, runInput)

	writeJSON(w, http.StatusOK, map[string]any{
		"run_id": runID, "status": "queued",
		"workflow_id": req.WorkflowID, "workspace_path": approved,
	})
}

// startExecution runs the workflow in the background.
//
// context.Background(), not the request context: the HTTP response returns
// immediately, and tying execution to the request would kill the run the moment
// the client disconnected — a browser tab closing would stop an agent mid-edit.
func (d *Deps) startExecution(runID, workflowID string, g graph.Graph, workspace string, runInput map[string]string) {
	engine := &runner.Runner{Store: d.Store}
	ctx, cancel := context.WithCancel(context.Background())
	d.trackRun(runID, cancel)

	go func() {
		defer d.untrackRun(runID)
		engine.RunWorkflow(ctx, runID, workflowID, g, workspace, runInput)
	}()
}

func homeDir() (string, error) { return os.UserHomeDir() }
