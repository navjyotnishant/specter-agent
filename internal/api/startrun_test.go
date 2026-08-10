// POST /api/workflow-runs.
//
// The workspace check is the security boundary of this endpoint: it decides
// which directory on the machine an agent is allowed to touch. It FAILS CLOSED
// — an unapproved path, a path outside every approved root, or no approved
// roots at all is a refusal, never a default.
//
// The subtle one is the parent check. /repos/app being approved must permit
// /repos/app/src but must NOT permit /repos/app-secrets, which shares a string
// prefix and is a different directory. A prefix comparison without the
// separator gets that wrong and grants access to a sibling.
package api

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/navjyotnishant/specter-agent/internal/store"
)

func approveWorkspace(t *testing.T, s *store.Store, path string) {
	t.Helper()
	if _, err := s.DB().Exec(
		`INSERT INTO runtime_workspaces (id, name, path, is_active) VALUES (?, ?, ?, 1)`,
		"ws-"+filepath.Base(path), filepath.Base(path), path); err != nil {
		t.Fatal(err)
	}
}

func seedWorkflow(t *testing.T, s *store.Store, id, name, workspace string) {
	t.Helper()
	if _, err := s.DB().Exec(
		`INSERT INTO workflows (id, name, graph_json, workspace_path)
		 VALUES (?, ?, '{"nodes":[{"id":"n1","type":"specialistAgent","data":{"label":"R","objective":"x"}}],"edges":[]}', ?)`,
		id, name, workspace); err != nil {
		t.Fatal(err)
	}
}

func TestStartRunRefusesAnUnapprovedWorkspace(t *testing.T) {
	srv, s := testServer(t)
	token, _ := bootstrapAdmin(t, srv)
	approved := t.TempDir()
	approveWorkspace(t, s, approved)
	seedWorkflow(t, s, "wf1", "Test", approved)

	code, body := call(t, srv, "POST", "/api/workflow-runs", token, map[string]any{
		"workflow_id": "wf1", "workspace_path": t.TempDir(), // a different, unapproved dir
	})
	if code != http.StatusForbidden {
		t.Fatalf("an unapproved workspace returned %d, want 403", code)
	}
	if detail, _ := body["detail"].(string); detail == "" {
		t.Error("the refusal did not say why")
	}

	var runs int
	s.DB().QueryRow(`SELECT COUNT(*) FROM workflow_runs`).Scan(&runs)
	if runs != 0 {
		t.Error("a run row was created for a refused workspace")
	}
}

func TestStartRunRefusesWhenNothingIsApproved(t *testing.T) {
	// Not provisioned is not permission.
	srv, s := testServer(t)
	token, _ := bootstrapAdmin(t, srv)
	seedWorkflow(t, s, "wf1", "Test", t.TempDir())

	if code, _ := call(t, srv, "POST", "/api/workflow-runs", token,
		map[string]any{"workflow_id": "wf1", "workspace_path": t.TempDir()}); code != http.StatusForbidden {
		t.Errorf("got %d with no approved workspaces, want 403", code)
	}
}

func TestASiblingDirectoryIsNotApprovedByPrefix(t *testing.T) {
	// /repos/app approved must NOT permit /repos/app-secrets. A prefix compare
	// without the separator grants access to a sibling directory.
	srv, s := testServer(t)
	token, _ := bootstrapAdmin(t, srv)

	base := t.TempDir()
	approved := filepath.Join(base, "app")
	sibling := filepath.Join(base, "app-secrets")
	os.MkdirAll(approved, 0o755)
	os.MkdirAll(sibling, 0o755)
	approveWorkspace(t, s, approved)
	seedWorkflow(t, s, "wf1", "Test", approved)

	if code, _ := call(t, srv, "POST", "/api/workflow-runs", token,
		map[string]any{"workflow_id": "wf1", "workspace_path": sibling}); code != http.StatusForbidden {
		t.Errorf("a sibling sharing a string prefix was approved (%d) — that is a different directory", code)
	}
}

func TestASubdirectoryOfAnApprovedRootIsAllowed(t *testing.T) {
	srv, s := testServer(t)
	token, _ := bootstrapAdmin(t, srv)

	approved := t.TempDir()
	sub := filepath.Join(approved, "src")
	os.MkdirAll(sub, 0o755)
	approveWorkspace(t, s, approved)
	seedWorkflow(t, s, "wf1", "Test", approved)

	code, _ := call(t, srv, "POST", "/api/workflow-runs", token,
		map[string]any{"workflow_id": "wf1", "workspace_path": sub})
	if code != http.StatusOK {
		t.Errorf("a subdirectory of an approved root was refused (%d)", code)
	}
}

func TestAnInactiveWorkspaceIsNotApproved(t *testing.T) {
	srv, s := testServer(t)
	token, _ := bootstrapAdmin(t, srv)
	workspace := t.TempDir()
	approveWorkspace(t, s, workspace)
	s.DB().Exec(`UPDATE runtime_workspaces SET is_active = 0`)
	seedWorkflow(t, s, "wf1", "Test", workspace)

	if code, _ := call(t, srv, "POST", "/api/workflow-runs", token,
		map[string]any{"workflow_id": "wf1", "workspace_path": workspace}); code != http.StatusForbidden {
		t.Errorf("a deactivated workspace was still approved (%d)", code)
	}
}

func TestStartRunFallsBackToTheWorkflowsOwnWorkspace(t *testing.T) {
	// Never a global default: running workflow A against workflow B's repo
	// would write to the wrong tree. A Telegram-triggered run carries no
	// workspace, so this path is the only source it has.
	srv, s := testServer(t)
	token, _ := bootstrapAdmin(t, srv)
	workspace := t.TempDir()
	approveWorkspace(t, s, workspace)
	seedWorkflow(t, s, "wf1", "Test", workspace)

	code, body := call(t, srv, "POST", "/api/workflow-runs", token,
		map[string]any{"workflow_id": "wf1"})
	if code != http.StatusOK {
		t.Fatalf("got %d without an explicit workspace", code)
	}
	if got, _ := body["workspace_path"].(string); got == "" {
		t.Error("no workspace was resolved")
	}
}

func TestAWorkflowWithNoWorkspaceSaysHowToFixIt(t *testing.T) {
	srv, s := testServer(t)
	token, _ := bootstrapAdmin(t, srv)
	approveWorkspace(t, s, t.TempDir())
	seedWorkflow(t, s, "wf1", "Test", "")

	code, body := call(t, srv, "POST", "/api/workflow-runs", token,
		map[string]any{"workflow_id": "wf1"})
	if code != http.StatusBadRequest {
		t.Fatalf("got %d, want 400", code)
	}
	detail, _ := body["detail"].(string)
	if detail == "" {
		t.Error("no explanation of what to do")
	}
}

func TestStartRunCreatesAQueuedRun(t *testing.T) {
	srv, s := testServer(t)
	token, _ := bootstrapAdmin(t, srv)
	workspace := t.TempDir()
	approveWorkspace(t, s, workspace)
	seedWorkflow(t, s, "wf1", "Test", workspace)

	code, body := call(t, srv, "POST", "/api/workflow-runs", token, map[string]any{
		"workflow_id": "wf1", "workspace_path": workspace, "trigger_type": "manual",
	})
	if code != http.StatusOK {
		t.Fatalf("got %d", code)
	}
	runID, _ := body["run_id"].(string)
	if runID == "" {
		t.Fatal("no run_id returned")
	}

	// The row exists immediately; execution is asynchronous. A caller that has
	// to poll for a run that does not exist yet cannot tell "starting" from
	// "rejected".
	var status, storedWorkspace string
	if err := s.DB().QueryRow(
		`SELECT status, workspace_path FROM workflow_runs WHERE id = ?`, runID).
		Scan(&status, &storedWorkspace); err != nil {
		t.Fatalf("no run row: %v", err)
	}
	if status != "queued" && status != "running" && status != "completed" && status != "failed" {
		t.Errorf("run status = %q", status)
	}
	if storedWorkspace == "" {
		t.Error("the run recorded no workspace")
	}
}

func TestStartingARunRemembersTheWorkspaceOnTheWorkflow(t *testing.T) {
	// So a later trigger-started run uses the same repo the UI last ran against.
	srv, s := testServer(t)
	token, _ := bootstrapAdmin(t, srv)

	base := t.TempDir()
	first := filepath.Join(base, "first")
	second := filepath.Join(base, "second")
	os.MkdirAll(first, 0o755)
	os.MkdirAll(second, 0o755)
	approveWorkspace(t, s, first)
	approveWorkspace(t, s, second)
	seedWorkflow(t, s, "wf1", "Test", first)

	call(t, srv, "POST", "/api/workflow-runs", token,
		map[string]any{"workflow_id": "wf1", "workspace_path": second})

	var remembered string
	s.DB().QueryRow(`SELECT workspace_path FROM workflows WHERE id = 'wf1'`).Scan(&remembered)
	resolved, _ := filepath.EvalSymlinks(second)
	if remembered != second && remembered != resolved {
		t.Errorf("workflow workspace = %q, want %q", remembered, second)
	}
}

func TestStartRunRequiresAdmin(t *testing.T) {
	// Starting a run spawns an agent against a repository. An operator reading
	// runs is not the same as an operator starting one.
	srv, s := testServer(t)
	adminToken, _ := bootstrapAdmin(t, srv)
	approveWorkspace(t, s, t.TempDir())
	seedWorkflow(t, s, "wf1", "Test", t.TempDir())

	call(t, srv, "POST", "/api/auth/users", adminToken,
		map[string]string{"email": "op@local.dev", "password": "hunter2hunter2", "role": "operator"})
	_, login := call(t, srv, "POST", "/api/auth/login", "",
		map[string]string{"email": "op@local.dev", "password": "hunter2hunter2"})
	opToken, _ := login["token"].(string)

	if code, _ := call(t, srv, "POST", "/api/workflow-runs", opToken,
		map[string]any{"workflow_id": "wf1"}); code != http.StatusForbidden {
		t.Errorf("an operator started a run (%d), want 403", code)
	}
	if code, _ := call(t, srv, "POST", "/api/workflow-runs", "",
		map[string]any{"workflow_id": "wf1"}); code != http.StatusUnauthorized {
		t.Errorf("an unauthenticated caller started a run (%d), want 401", code)
	}
}

func TestStartingAnUnknownWorkflowIs404(t *testing.T) {
	srv, s := testServer(t)
	token, _ := bootstrapAdmin(t, srv)
	approveWorkspace(t, s, t.TempDir())

	if code, _ := call(t, srv, "POST", "/api/workflow-runs", token,
		map[string]any{"workflow_id": "nope"}); code != http.StatusNotFound {
		t.Errorf("got %d, want 404", code)
	}
}
