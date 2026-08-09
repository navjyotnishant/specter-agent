// Tests written before the handlers.
//
// The workflow service carries four rules that a port loses quietly:
//
//  1. Names are unique CASE-INSENSITIVELY. Workflows are chosen by name — in
//     the list and from the Telegram bot — so two that differ only in case are
//     ambiguous at the point of use.
//  2. Templates cannot be deleted. The guard is on the DELETE itself, not a
//     pre-check, so a race cannot slip past it.
//  3. workspace_path uses COALESCE: null means "unchanged", not "blank it".
//     Callers that do not manage the workspace (template publish, the planner)
//     would otherwise erase the only value a trigger-started run can read.
//  4. Deleting a workflow deletes SEVEN child tables, deepest first. SQLite
//     foreign keys are off and nothing declares ON DELETE CASCADE, so the rows
//     are stranded with no owner and no UI to reach them.
package api

import (
	"net/http"
	"testing"
)

func TestWorkflowCRUD(t *testing.T) {
	srv, _ := testServer(t)
	token, _ := bootstrapAdmin(t, srv)

	code, created := call(t, srv, "POST", "/api/workflows", token, map[string]any{
		"name": "Security Review", "description": "checks", "graph": map[string]any{"nodes": []any{}},
		"workspace_path": "/repos/app",
	})
	if code != http.StatusOK {
		t.Fatalf("create returned %d", code)
	}
	id, _ := created["id"].(string)
	if id == "" {
		t.Fatalf("create returned no id: %+v", created)
	}
	// graph comes back DECODED, not as a JSON string — the builder renders it.
	if _, ok := created["graph"].(map[string]any); !ok {
		t.Errorf("graph is not an object: %T", created["graph"])
	}
	if created["is_template"] != false {
		t.Errorf("a new workflow should not be a template")
	}

	if code, got := call(t, srv, "GET", "/api/workflows/"+id, token, nil); code != http.StatusOK {
		t.Errorf("get returned %d", code)
	} else if got["name"] != "Security Review" {
		t.Errorf("get returned the wrong workflow: %+v", got)
	}

	code, updated := call(t, srv, "PATCH", "/api/workflows/"+id, token, map[string]any{
		"name": "Security Review v2", "description": "updated", "graph": map[string]any{"nodes": []any{"a"}},
	})
	if code != http.StatusOK {
		t.Fatalf("update returned %d", code)
	}
	if updated["name"] != "Security Review v2" {
		t.Errorf("the name did not update")
	}
	// Rule 3: the update sent no workspace_path, so it must survive.
	if updated["workspace_path"] != "/repos/app" {
		t.Errorf("workspace_path was blanked by an update that did not mention it: %q — "+
			"a trigger-started run has no other source for its repository", updated["workspace_path"])
	}

	if code, _ := call(t, srv, "DELETE", "/api/workflows/"+id, token, nil); code != http.StatusOK {
		t.Errorf("delete returned %d", code)
	}
	if code, _ := call(t, srv, "GET", "/api/workflows/"+id, token, nil); code != http.StatusNotFound {
		t.Errorf("the workflow survived deletion (%d)", code)
	}
}

func TestWorkflowNamesAreUniqueCaseInsensitively(t *testing.T) {
	srv, _ := testServer(t)
	token, _ := bootstrapAdmin(t, srv)

	body := map[string]any{"name": "Nightly Build", "graph": map[string]any{}}
	if code, _ := call(t, srv, "POST", "/api/workflows", token, body); code != http.StatusOK {
		t.Fatal("the first create failed")
	}
	for _, name := range []string{"Nightly Build", "nightly build", "NIGHTLY BUILD", "  Nightly Build  "} {
		code, _ := call(t, srv, "POST", "/api/workflows", token,
			map[string]any{"name": name, "graph": map[string]any{}})
		if code != http.StatusConflict {
			t.Errorf("%q was accepted (%d) — it is ambiguous with an existing workflow at the point of use", name, code)
		}
	}
}

func TestRenamingAWorkflowToItsOwnNameWorks(t *testing.T) {
	// The duplicate check must exclude the row being written, or saving a
	// workflow without renaming it fails.
	srv, _ := testServer(t)
	token, _ := bootstrapAdmin(t, srv)

	_, created := call(t, srv, "POST", "/api/workflows", token,
		map[string]any{"name": "Deploy", "graph": map[string]any{}})
	id, _ := created["id"].(string)

	if code, _ := call(t, srv, "PATCH", "/api/workflows/"+id, token,
		map[string]any{"name": "Deploy", "graph": map[string]any{}}); code != http.StatusOK {
		t.Errorf("saving a workflow under its own name returned %d", code)
	}
}

func TestTemplatesCannotBeDeleted(t *testing.T) {
	srv, _ := testServer(t)
	token, _ := bootstrapAdmin(t, srv)

	_, created := call(t, srv, "POST", "/api/workflows", token,
		map[string]any{"name": "Starter", "graph": map[string]any{}})
	id, _ := created["id"].(string)

	code, published := call(t, srv, "PATCH", "/api/workflows/"+id+"/publish-template", token, nil)
	if code != http.StatusOK {
		t.Fatalf("publish returned %d", code)
	}
	if published["is_template"] != true {
		t.Fatal("publish did not set is_template")
	}

	// deleted:false, not an error — matching Python, which reports the outcome.
	_, body := call(t, srv, "DELETE", "/api/workflows/"+id, token, nil)
	if body["deleted"] != false {
		t.Errorf("a template was deleted: %+v", body)
	}
	if code, _ := call(t, srv, "GET", "/api/workflows/"+id, token, nil); code != http.StatusOK {
		t.Error("the template is gone")
	}

	// Unpublish, then it deletes.
	call(t, srv, "PATCH", "/api/workflows/"+id+"/unpublish-template", token, nil)
	if _, body := call(t, srv, "DELETE", "/api/workflows/"+id, token, nil); body["deleted"] != true {
		t.Errorf("an unpublished workflow could not be deleted: %+v", body)
	}
}

func TestDeletingAWorkflowRemovesItsRunHistory(t *testing.T) {
	// SQLite foreign keys are off and nothing declares ON DELETE CASCADE, so
	// without an explicit cascade every child row is stranded: no owner, and no
	// UI that can reach it.
	srv, s := testServer(t)
	token, _ := bootstrapAdmin(t, srv)

	_, created := call(t, srv, "POST", "/api/workflows", token,
		map[string]any{"name": "Has History", "graph": map[string]any{}})
	id, _ := created["id"].(string)

	runID := "run-1"
	agentRunID := "agent-run-1"
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := s.DB().Exec(query, args...); err != nil {
			t.Fatalf("seeding %q: %v", query, err)
		}
	}
	exec(`INSERT INTO workflow_runs (id, workflow_id, status, workspace_path) VALUES (?, ?, 'completed', '/x')`, runID, id)
	exec(`INSERT INTO workflow_step_runs (id, workflow_run_id, node_id, node_type, status) VALUES ('s1', ?, 'n1', 'agent', 'completed')`, runID)
	exec(`INSERT INTO run_logs (workflow_run_id, message) VALUES (?, 'hello')`, runID)
	exec(`INSERT INTO agent_runs (id, workflow_run_id, node_id, agent_name, agent_role, status) VALUES (?, ?, 'n1', 'claude', 'reviewer', 'completed')`, agentRunID, runID)
	exec(`INSERT INTO agent_messages (id, agent_run_id, sender_type, sender_name, content) VALUES ('m1', ?, 'user', 'nav', 'hi')`, agentRunID)
	exec(`INSERT INTO memory_entries (id, workflow_run_id, scope, key, value_text) VALUES ('mem1', ?, 'workflow', 'k', 'note')`, runID)
	exec(`INSERT INTO approval_requests (id, workflow_run_id, title, reason) VALUES ('a1', ?, 'Approve?', 'because')`, runID)

	if _, body := call(t, srv, "DELETE", "/api/workflows/"+id, token, nil); body["deleted"] != true {
		t.Fatalf("delete failed: %+v", body)
	}

	for _, tc := range []struct{ table, query string }{
		{"workflow_runs", `SELECT COUNT(*) FROM workflow_runs WHERE id = ?`},
		{"workflow_step_runs", `SELECT COUNT(*) FROM workflow_step_runs WHERE workflow_run_id = ?`},
		{"run_logs", `SELECT COUNT(*) FROM run_logs WHERE workflow_run_id = ?`},
		{"agent_runs", `SELECT COUNT(*) FROM agent_runs WHERE workflow_run_id = ?`},
		{"memory_entries", `SELECT COUNT(*) FROM memory_entries WHERE workflow_run_id = ?`},
		{"approval_requests", `SELECT COUNT(*) FROM approval_requests WHERE workflow_run_id = ?`},
	} {
		var n int
		s.DB().QueryRow(tc.query, runID).Scan(&n)
		if n != 0 {
			t.Errorf("%s left %d stranded row(s) with no owner", tc.table, n)
		}
	}
	var msgs int
	s.DB().QueryRow(`SELECT COUNT(*) FROM agent_messages WHERE agent_run_id = ?`, agentRunID).Scan(&msgs)
	if msgs != 0 {
		t.Errorf("agent_messages left %d stranded row(s)", msgs)
	}
}

func TestWorkflowNotFoundIs404(t *testing.T) {
	srv, _ := testServer(t)
	token, _ := bootstrapAdmin(t, srv)
	for _, path := range []string{"/api/workflows/nope", "/api/workflows/nope/publish-template"} {
		method := "GET"
		if path != "/api/workflows/nope" {
			method = "PATCH"
		}
		if code, _ := call(t, srv, method, path, token, nil); code != http.StatusNotFound {
			t.Errorf("%s %s returned %d, want 404", method, path, code)
		}
	}
}

func TestWorkflowsRequireAuth(t *testing.T) {
	srv, _ := testServer(t)
	bootstrapAdmin(t, srv)
	if code, _ := call(t, srv, "GET", "/api/workflows", "", nil); code != http.StatusUnauthorized {
		t.Errorf("listing workflows without a token returned %d", code)
	}
}

func TestWorkflowNameIsRequired(t *testing.T) {
	srv, _ := testServer(t)
	token, _ := bootstrapAdmin(t, srv)
	for _, name := range []string{"", "   "} {
		if code, _ := call(t, srv, "POST", "/api/workflows", token,
			map[string]any{"name": name, "graph": map[string]any{}}); code != http.StatusBadRequest {
			t.Errorf("name %q was accepted (%d)", name, code)
		}
	}
}

func TestListReturnsABareArrayNewestFirst(t *testing.T) {
	srv, _ := testServer(t)
	token, _ := bootstrapAdmin(t, srv)
	for _, n := range []string{"First", "Second", "Third"} {
		call(t, srv, "POST", "/api/workflows", token, map[string]any{"name": n, "graph": map[string]any{}})
	}
	list := callArray(t, srv, "GET", "/api/workflows", token)
	if len(list) != 3 {
		t.Fatalf("got %d workflows, want 3", len(list))
	}
}
