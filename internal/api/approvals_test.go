// The approvals READ surface, plus run memory and /health/system.
//
// Resolving an approval (approve / reject / request-revision) is NOT here: each
// resumes the run through graph_runner, which is a ~950-line engine that has not
// been ported. A resolve endpoint that records a decision without resuming the
// run is worse than a 404 — it would report success while the run stayed
// suspended forever.
//
// The memory routes have no authentication in Python (issue #40): DELETE
// /api/runs/{id}/memory wipes a run's memory with no session. This port
// requires one.
package api

import (
	"net/http"
	"testing"

	"github.com/navjyotnishant/specter-agent/internal/store"
)

func seedApproval(t *testing.T, s *store.Store, id, runID, status string) {
	t.Helper()
	if _, err := s.DB().Exec(
		`INSERT INTO approval_requests (id, workflow_run_id, status, title, reason,
		        proposed_action_json, context_summary, requested_by_agent)
		 VALUES (?, ?, ?, 'Write the file?', 'agent wants to write', '{"path":"/x"}', 'summary', 'claude')`,
		id, runID, status); err != nil {
		t.Fatalf("seeding approval %s: %v", id, err)
	}
}

func TestApprovalReadSurface(t *testing.T) {
	srv, s := testServer(t)
	token, _ := bootstrapAdmin(t, srv)
	seedRun(t, s, "r1", "wf1", "waiting_approval", "-1 hours", "")
	seedApproval(t, s, "a1", "r1", "pending")

	list := callArray(t, srv, "GET", "/api/approvals", token)
	if len(list) != 1 {
		t.Fatalf("got %d approvals, want 1", len(list))
	}
	if list[0]["title"] != "Write the file?" {
		t.Errorf("wrong approval: %+v", list[0])
	}
	// proposed_action comes back DECODED, not as a JSON string.
	if _, ok := list[0]["proposed_action"].(map[string]any); !ok {
		t.Errorf("proposed_action is not an object: %T", list[0]["proposed_action"])
	}

	code, one := call(t, srv, "GET", "/api/approvals/a1", token, nil)
	if code != http.StatusOK {
		t.Fatalf("get approval returned %d", code)
	}
	if one["id"] != "a1" || one["status"] != "pending" {
		t.Errorf("wrong approval: %+v", one)
	}
}

func TestApprovalsFilterByStatus(t *testing.T) {
	srv, s := testServer(t)
	token, _ := bootstrapAdmin(t, srv)
	seedRun(t, s, "r1", "wf1", "waiting_approval", "-1 hours", "")
	seedApproval(t, s, "a1", "r1", "pending")
	seedApproval(t, s, "a2", "r1", "approved")
	seedApproval(t, s, "a3", "r1", "rejected")

	if all := callArray(t, srv, "GET", "/api/approvals", token); len(all) != 3 {
		t.Errorf("unfiltered returned %d, want 3", len(all))
	}
	if pending := callArray(t, srv, "GET", "/api/approvals?status=pending", token); len(pending) != 1 {
		t.Errorf("status=pending returned %d, want 1", len(pending))
	}
}

func TestRunApprovalsAreScopedToTheirRun(t *testing.T) {
	// /workflow-runs/{id}/approvals must not leak another run's approvals.
	srv, s := testServer(t)
	token, _ := bootstrapAdmin(t, srv)
	seedRun(t, s, "r1", "wf1", "waiting_approval", "-1 hours", "")
	seedRun(t, s, "r2", "wf1", "waiting_approval", "-1 hours", "")
	seedApproval(t, s, "a1", "r1", "pending")
	seedApproval(t, s, "a2", "r2", "pending")

	got := callArray(t, srv, "GET", "/api/workflow-runs/r1/approvals", token)
	if len(got) != 1 {
		t.Fatalf("got %d approvals for r1, want 1", len(got))
	}
	if got[0]["id"] != "a1" {
		t.Errorf("returned another run's approval: %+v", got[0])
	}
}

func TestApprovalNotFoundIs404(t *testing.T) {
	srv, _ := testServer(t)
	token, _ := bootstrapAdmin(t, srv)
	if code, _ := call(t, srv, "GET", "/api/approvals/nope", token, nil); code != http.StatusNotFound {
		t.Errorf("got %d, want 404", code)
	}
}

func TestApprovalsRequireAuth(t *testing.T) {
	// An approval gate is the human-in-the-loop control for agents that write
	// files and post externally. An unauthenticated read of what is pending is
	// a disclosure of exactly what the gate exists to control.
	srv, _ := testServer(t)
	bootstrapAdmin(t, srv)
	for _, path := range []string{"/api/approvals", "/api/approvals/a1", "/api/workflow-runs/r1/approvals"} {
		if code, _ := call(t, srv, "GET", path, "", nil); code != http.StatusUnauthorized {
			t.Errorf("GET %s without a token returned %d", path, code)
		}
	}
}

func TestRunMemoryReadAndClear(t *testing.T) {
	srv, s := testServer(t)
	token, _ := bootstrapAdmin(t, srv)
	seedRun(t, s, "r1", "wf1", "completed", "-1 hours", "-30 minutes")
	for i, key := range []string{"k1", "k2"} {
		if _, err := s.DB().Exec(
			`INSERT INTO memory_entries (id, workflow_run_id, scope, key, value_text)
			 VALUES (?, 'r1', 'workflow', ?, ?)`,
			"m"+string(rune('1'+i)), key, "value-"+key); err != nil {
			t.Fatal(err)
		}
	}

	entries := callArray(t, srv, "GET", "/api/runs/r1/memory", token)
	if len(entries) != 2 {
		t.Fatalf("got %d memory entries, want 2", len(entries))
	}

	_, body := call(t, srv, "DELETE", "/api/runs/r1/memory", token, nil)
	if body["deleted"] != float64(2) {
		t.Errorf("deleted = %v, want 2", body["deleted"])
	}
	if left := callArray(t, srv, "GET", "/api/runs/r1/memory", token); len(left) != 0 {
		t.Errorf("%d entries survived the clear", len(left))
	}
}

// Issue #40: memory.py has no auth in Python, so DELETE wipes a run's memory
// with no session at all.
func TestMemoryRequiresAuth(t *testing.T) {
	srv, _ := testServer(t)
	bootstrapAdmin(t, srv)
	for _, tc := range []struct{ method, path string }{
		{"GET", "/api/runs/r1/memory"},
		{"DELETE", "/api/runs/r1/memory"},
	} {
		if code, _ := call(t, srv, tc.method, tc.path, "", nil); code != http.StatusUnauthorized {
			t.Errorf("%s %s returned %d without a token, want 401 (issue #40)", tc.method, tc.path, code)
		}
	}
}

func TestSystemHealthReportsRealSamples(t *testing.T) {
	srv, _ := testServer(t)
	_, body := call(t, srv, "GET", "/api/health/system", "", nil)

	for _, key := range []string{"sampled_at", "load", "memory", "disk"} {
		if _, ok := body[key]; !ok {
			t.Errorf("missing %q — the dashboard runtime panel reads these", key)
		}
	}
	// Disk is the one that must be real: a hardcoded "healthy" here means the
	// panel says fine while the volume holding the database is full.
	disk, ok := body["disk"].(map[string]any)
	if !ok {
		t.Fatalf("disk is not an object: %T", body["disk"])
	}
	if disk["total_bytes"] == nil || disk["total_bytes"] == float64(0) {
		t.Errorf("disk.total_bytes = %v — not a real sample", disk["total_bytes"])
	}
	if disk["free_bytes"] == nil {
		t.Error("disk.free_bytes missing")
	}
}
