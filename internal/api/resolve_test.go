// The three approval resolution endpoints, plus startup recovery.
//
// Resolving is only half the job. A gate answered in the database while nothing
// is executing leaves the run at waiting_approval forever — the UI shows an
// APPROVED gate on a dead run, which is the most confusing of the stranding
// modes because everything looks fine.
package api

import (
	"net/http"
	"testing"
	"time"

	"github.com/navjyotnishant/specter-agent/internal/store"
)

func seedGate(t *testing.T, s *store.Store, runID, approvalID, status string) {
	t.Helper()
	if _, err := s.DB().Exec(
		`INSERT OR IGNORE INTO workflows (id, name, graph_json) VALUES ('wf1','Test','{}')`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB().Exec(
		`INSERT OR IGNORE INTO workflow_runs (id, workflow_id, status, workspace_path, graph_json)
		 VALUES (?, 'wf1', 'waiting_approval', '/tmp', '{}')`, runID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB().Exec(
		`INSERT INTO approval_requests (id, workflow_run_id, status, title, reason)
		 VALUES (?, ?, ?, 'Sign off', 'check')`, approvalID, runID, status); err != nil {
		t.Fatal(err)
	}
}

func approvalStatus(t *testing.T, s *store.Store, approvalID string) string {
	t.Helper()
	var status string
	if err := s.DB().QueryRow(
		`SELECT status FROM approval_requests WHERE id = ?`, approvalID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	return status
}

func TestApproveRejectAndRequestRevision(t *testing.T) {
	cases := []struct{ path, want, runWant string }{
		{"approve", "approved", "running"},
		{"reject", "rejected", "rejected"},
		{"request-revision", "revision_requested", "revision_requested"},
	}
	for _, c := range cases {
		t.Run(c.path, func(t *testing.T) {
			srv, s := testServer(t)
			token, _ := bootstrapAdmin(t, srv)
			seedGate(t, s, "r-"+c.path, "a-"+c.path, "pending")

			code, _ := call(t, srv, "POST",
				"/api/workflow-runs/r-"+c.path+"/"+c.path+"/a-"+c.path, token,
				map[string]any{"comment": "looks fine"})
			if code != http.StatusOK {
				t.Fatalf("%s returned %d", c.path, code)
			}
			if got := approvalStatus(t, s, "a-"+c.path); got != c.want {
				t.Errorf("approval status = %q, want %q", got, c.want)
			}
			if got := statusOf(t, s, "r-"+c.path); got != c.runWant {
				t.Errorf("run status = %q, want %q", got, c.runWant)
			}
		})
	}
}

func TestResolutionRecordsWhoAndWhy(t *testing.T) {
	// An approval with no attributed decider is not an audit trail.
	srv, s := testServer(t)
	token, adminID := bootstrapAdmin(t, srv)
	seedGate(t, s, "r1", "a1", "pending")

	call(t, srv, "POST", "/api/workflow-runs/r1/approve/a1", token,
		map[string]any{"comment": "checked the diff"})

	var resolvedBy, comment, resolvedAt *string
	s.DB().QueryRow(
		`SELECT resolved_by_user_id, resolution_comment, resolved_at FROM approval_requests WHERE id = 'a1'`).
		Scan(&resolvedBy, &comment, &resolvedAt)
	if resolvedBy == nil || *resolvedBy != adminID {
		t.Errorf("resolved_by_user_id = %v, want the signed-in admin", resolvedBy)
	}
	if comment == nil || *comment != "checked the diff" {
		t.Errorf("resolution_comment = %v", comment)
	}
	if resolvedAt == nil || *resolvedAt == "" {
		t.Error("resolved_at was not stamped")
	}
}

func TestAnAlreadyResolvedApprovalCannotBeChanged(t *testing.T) {
	// A second click must not flip a rejection into an approval — the run has
	// already acted on the first answer.
	srv, s := testServer(t)
	token, _ := bootstrapAdmin(t, srv)
	seedGate(t, s, "r1", "a1", "rejected")

	code, _ := call(t, srv, "POST", "/api/workflow-runs/r1/approve/a1", token, nil)
	if code != http.StatusBadRequest {
		t.Errorf("re-resolving returned %d, want 400", code)
	}
	if got := approvalStatus(t, s, "a1"); got != "rejected" {
		t.Errorf("approval status = %q — a resolved approval was overwritten", got)
	}
}

func TestAnExpiredApprovalCannotBeApproved(t *testing.T) {
	// The expiry already cancelled the run; approving it later must not claim
	// otherwise.
	srv, s := testServer(t)
	token, _ := bootstrapAdmin(t, srv)
	seedGate(t, s, "r1", "a1", "expired")

	if code, _ := call(t, srv, "POST", "/api/workflow-runs/r1/approve/a1", token, nil); code != http.StatusBadRequest {
		t.Errorf("an expired approval was approved (%d)", code)
	}
	if got := approvalStatus(t, s, "a1"); got != "expired" {
		t.Errorf("approval status = %q", got)
	}
}

func TestAPendingApprovalPastItsDeadlineExpiresOnRead(t *testing.T) {
	// Expiry runs on READ, not on a timer: there is no scheduler to miss, and a
	// backend that was down over the deadline still notices.
	srv, s := testServer(t)
	token, _ := bootstrapAdmin(t, srv)
	seedGate(t, s, "r1", "a1", "pending")
	s.DB().Exec(`UPDATE approval_requests SET expires_at = '2020-01-01T00:00:00+00:00' WHERE id = 'a1'`)

	call(t, srv, "GET", "/api/workflow-runs/r1/approvals", token, nil)

	if got := approvalStatus(t, s, "a1"); got != "expired" {
		t.Errorf("approval status = %q, want expired after reading past its deadline", got)
	}
	if got := statusOf(t, s, "r1"); got != "cancelled" {
		t.Errorf("run status = %q, want cancelled — an expired gate cancels its run", got)
	}
}

func TestResolvingAnUnknownApprovalIs404(t *testing.T) {
	srv, s := testServer(t)
	token, _ := bootstrapAdmin(t, srv)
	seedGate(t, s, "r1", "a1", "pending")

	if code, _ := call(t, srv, "POST", "/api/workflow-runs/r1/approve/ghost", token, nil); code != http.StatusNotFound {
		t.Errorf("got %d, want 404", code)
	}
	// An approval belonging to a DIFFERENT run must not resolve through this one.
	seedGate(t, s, "r2", "a2", "pending")
	if code, _ := call(t, srv, "POST", "/api/workflow-runs/r1/approve/a2", token, nil); code != http.StatusNotFound {
		t.Errorf("an approval from another run resolved (%d)", code)
	}
}

func TestResolvingRequiresAdmin(t *testing.T) {
	// An approval gate is the human-in-the-loop control for agents that write
	// files and post externally.
	srv, s := testServer(t)
	adminToken, _ := bootstrapAdmin(t, srv)
	seedGate(t, s, "r1", "a1", "pending")

	call(t, srv, "POST", "/api/auth/users", adminToken,
		map[string]string{"email": "op@local.dev", "password": "hunter2hunter2", "role": "operator"})
	_, login := call(t, srv, "POST", "/api/auth/login", "",
		map[string]string{"email": "op@local.dev", "password": "hunter2hunter2"})
	opToken, _ := login["token"].(string)

	if code, _ := call(t, srv, "POST", "/api/workflow-runs/r1/approve/a1", opToken, nil); code != http.StatusForbidden {
		t.Errorf("an operator approved a gate (%d), want 403", code)
	}
	if code, _ := call(t, srv, "POST", "/api/workflow-runs/r1/approve/a1", "", nil); code != http.StatusUnauthorized {
		t.Errorf("an unauthenticated caller approved a gate (%d), want 401", code)
	}
}

// STRANDING MODE 2, at the API level. Approving in the database while nothing
// is executing leaves the run at waiting_approval forever.
func TestApprovingResumesAStrandedRun(t *testing.T) {
	srv, s := testServer(t)
	token, _ := bootstrapAdmin(t, srv)

	workspace := t.TempDir()
	approveWorkspace(t, s, workspace)
	// A run suspended at a gate, with nothing executing — exactly what a backend
	// restart leaves behind.
	if _, err := s.DB().Exec(
		`INSERT INTO workflows (id, name, graph_json, workspace_path)
		 VALUES ('wf1','Gated','{"nodes":[{"id":"g1","type":"humanApproval","data":{"label":"Sign off"}}],"edges":[]}', ?)`,
		workspace); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB().Exec(
		`INSERT INTO workflow_runs (id, workflow_id, status, workspace_path, graph_json)
		 VALUES ('r1','wf1','waiting_approval', ?, '{"nodes":[{"id":"g1","type":"humanApproval","data":{"label":"Sign off"}}],"edges":[]}')`,
		workspace); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB().Exec(
		`INSERT INTO workflow_step_runs (id, workflow_run_id, node_id, node_type, status)
		 VALUES ('sg','r1','g1','humanApproval','waiting_approval')`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB().Exec(
		`INSERT INTO agent_runs (id, workflow_run_id, node_id, agent_name, agent_role, status)
		 VALUES ('sg','r1','g1','Sign off','humanApproval','waiting_approval')`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB().Exec(
		`INSERT INTO approval_requests (id, workflow_run_id, workflow_step_run_id, status, title, reason)
		 VALUES ('a1','r1','sg','pending','Sign off','check')`); err != nil {
		t.Fatal(err)
	}

	if code, _ := call(t, srv, "POST", "/api/workflow-runs/r1/approve/a1", token, nil); code != http.StatusOK {
		t.Fatalf("approve returned %d", code)
	}

	// The run must LEAVE waiting_approval. Marking the approval alone would
	// leave it stranded with an approved gate on a dead run.
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if got := statusOf(t, s, "r1"); got != "waiting_approval" {
			if got != "completed" && got != "running" {
				t.Errorf("run status = %q after approval", got)
			}
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Error("the run was still waiting_approval 10s after being approved — approving marked a row " +
		"but resumed nothing, so the UI shows an approved gate on a dead run")
}

// Startup recovery: an approval that landed while the backend was down.
func TestRecoveryRestartsRunsApprovedWhileDown(t *testing.T) {
	srv, s := testServer(t)
	bootstrapAdmin(t, srv)

	workspace := t.TempDir()
	approveWorkspace(t, s, workspace)
	graphJSON := `{"nodes":[{"id":"g1","type":"humanApproval","data":{"label":"Sign off"}}],"edges":[]}`

	s.DB().Exec(`INSERT INTO workflows (id,name,graph_json,workspace_path) VALUES ('wf1','G',?,?)`, graphJSON, workspace)
	s.DB().Exec(
		`INSERT INTO workflow_runs (id,workflow_id,status,workspace_path,graph_json)
		 VALUES ('r1','wf1','waiting_approval',?,?)`, workspace, graphJSON)
	s.DB().Exec(
		`INSERT INTO workflow_step_runs (id,workflow_run_id,node_id,node_type,status)
		 VALUES ('sg','r1','g1','humanApproval','waiting_approval')`)
	s.DB().Exec(
		`INSERT INTO agent_runs (id,workflow_run_id,node_id,agent_name,agent_role,status)
		 VALUES ('sg','r1','g1','Sign off','humanApproval','waiting_approval')`)
	// Approved while nothing was executing.
	s.DB().Exec(
		`INSERT INTO approval_requests (id,workflow_run_id,workflow_step_run_id,status,title,reason)
		 VALUES ('a1','r1','sg','approved','Sign off','check')`)

	deps := &Deps{Store: s}
	if recovered := deps.RecoverApprovedWaitingRuns(); recovered != 1 {
		t.Fatalf("recovered %d runs, want 1", recovered)
	}

	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if got := statusOf(t, s, "r1"); got != "waiting_approval" {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Error("the run was still waiting_approval after recovery")
}

func TestRecoveryIgnoresRunsWithNoApproval(t *testing.T) {
	// Only runs whose gate is ALREADY approved are restarted. Restarting one
	// still genuinely waiting would run it with nobody having said yes.
	srv, s := testServer(t)
	bootstrapAdmin(t, srv)
	seedGate(t, s, "r1", "a1", "pending")

	deps := &Deps{Store: s}
	if recovered := deps.RecoverApprovedWaitingRuns(); recovered != 0 {
		t.Errorf("recovered %d runs that are still waiting for a human", recovered)
	}
}

// The /api/approvals/{id}/... routes must share every guard the run-scoped ones
// have. A second implementation that only marked the row would strand runs
// resolved through this path while the other path worked — split-brain, and
// slow to notice.
func TestApprovalCanBeResolvedByIDAlone(t *testing.T) {
	srv, s := testServer(t)
	token, _ := bootstrapAdmin(t, srv)
	seedGate(t, s, "r1", "a1", "pending")

	code, _ := call(t, srv, "POST", "/api/approvals/a1/approve", token,
		map[string]any{"comment": "fine"})
	if code != http.StatusOK {
		t.Fatalf("returned %d", code)
	}
	if got := approvalStatus(t, s, "a1"); got != "approved" {
		t.Errorf("approval status = %q", got)
	}
	// The run must move too, not just the approval row.
	if got := statusOf(t, s, "r1"); got == "waiting_approval" {
		t.Error("the run was left waiting — this path marked a row and resumed nothing")
	}
}

func TestResolvingByIDRejectsAnAlreadyResolvedApproval(t *testing.T) {
	srv, s := testServer(t)
	token, _ := bootstrapAdmin(t, srv)
	seedGate(t, s, "r1", "a1", "rejected")

	if code, _ := call(t, srv, "POST", "/api/approvals/a1/approve", token, nil); code != http.StatusBadRequest {
		t.Errorf("got %d, want 400 — this path skipped the pending guard", code)
	}
}

func TestResolvingAnUnknownApprovalByIDIs404(t *testing.T) {
	srv, _ := testServer(t)
	token, _ := bootstrapAdmin(t, srv)
	if code, _ := call(t, srv, "POST", "/api/approvals/ghost/approve", token, nil); code != http.StatusNotFound {
		t.Errorf("got %d, want 404", code)
	}
}
