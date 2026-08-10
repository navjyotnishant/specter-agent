// POST /api/workflow-runs/{id}/cancel.
//
// Python only marks the row; the subprocess keeps running until the loop
// notices between nodes. Go holds a cancel function per in-flight run, so it
// can actually kill the agent — a "cancelled" run whose agent is still editing
// files is a lie the UI tells.
//
// The endpoint still marks the row either way, because a run may be in flight
// in a DIFFERENT process (the Python backend, or another specter serve against
// the same database) where this one has nothing to kill.
package api

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/navjyotnishant/specter-agent/internal/store"
)

func seedRunWithStatus(t *testing.T, s *store.Store, runID, status string) {
	t.Helper()
	if _, err := s.DB().Exec(
		`INSERT OR IGNORE INTO workflows (id, name, graph_json) VALUES ('wf1','Test','{}')`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB().Exec(
		`INSERT INTO workflow_runs (id, workflow_id, status, workspace_path, graph_json)
		 VALUES (?, 'wf1', ?, '/tmp', '{}')`, runID, status); err != nil {
		t.Fatal(err)
	}
}

func statusOf(t *testing.T, s *store.Store, runID string) string {
	t.Helper()
	var status string
	if err := s.DB().QueryRow(`SELECT status FROM workflow_runs WHERE id = ?`, runID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	return status
}

func TestCancelMarksARunningRunCancelled(t *testing.T) {
	srv, s := testServer(t)
	token, _ := bootstrapAdmin(t, srv)
	seedRunWithStatus(t, s, "r1", "running")

	code, body := call(t, srv, "POST", "/api/workflow-runs/r1/cancel", token, nil)
	if code != http.StatusOK {
		t.Fatalf("cancel returned %d", code)
	}
	if body["cancelled"] != true {
		t.Errorf("body = %+v", body)
	}
	if got := statusOf(t, s, "r1"); got != "cancelled" {
		t.Errorf("run status = %q, want cancelled", got)
	}
}

func TestCancelStampsCompletedAt(t *testing.T) {
	// Without it the run has no end time and shows as open-ended in the UI.
	srv, s := testServer(t)
	token, _ := bootstrapAdmin(t, srv)
	seedRunWithStatus(t, s, "r1", "running")
	call(t, srv, "POST", "/api/workflow-runs/r1/cancel", token, nil)

	var completedAt *string
	s.DB().QueryRow(`SELECT completed_at FROM workflow_runs WHERE id = 'r1'`).Scan(&completedAt)
	if completedAt == nil || *completedAt == "" {
		t.Error("completed_at was not stamped")
	}
}

func TestCancelDoesNotReopenAFinishedRun(t *testing.T) {
	// A completed run that later reports "cancelled" rewrites history: the work
	// happened, and the record would deny it.
	srv, s := testServer(t)
	token, _ := bootstrapAdmin(t, srv)

	for _, terminal := range []string{"completed", "failed", "cancelled"} {
		runID := "r-" + terminal
		seedRunWithStatus(t, s, runID, terminal)
		call(t, srv, "POST", "/api/workflow-runs/"+runID+"/cancel", token, nil)
		if got := statusOf(t, s, runID); got != terminal {
			t.Errorf("a %s run became %q after cancel", terminal, got)
		}
	}
}

func TestCancelWorksOnAQueuedAndAWaitingRun(t *testing.T) {
	// A run waiting on a human is exactly the one an operator wants to abandon.
	srv, s := testServer(t)
	token, _ := bootstrapAdmin(t, srv)

	for _, status := range []string{"queued", "waiting_approval"} {
		runID := "r-" + status
		seedRunWithStatus(t, s, runID, status)
		call(t, srv, "POST", "/api/workflow-runs/"+runID+"/cancel", token, nil)
		if got := statusOf(t, s, runID); got != "cancelled" {
			t.Errorf("a %s run was not cancelled (got %q)", status, got)
		}
	}
}

func TestCancelActuallyKillsTheAgent(t *testing.T) {
	// The difference from Python. A run marked cancelled whose agent keeps
	// editing files is a lie the UI tells.
	_, s := testServer(t)

	workspace := t.TempDir()
	approveWorkspace(t, s, workspace)
	if _, err := s.DB().Exec(
		`INSERT INTO workflows (id, name, graph_json, workspace_path)
		 VALUES ('wf1','Slow','{"nodes":[{"id":"n1","type":"specialistAgent","data":{"label":"Slow","objective":"x"}}],"edges":[]}', ?)`,
		workspace); err != nil {
		t.Fatal(err)
	}

	// A fake agent that would run far longer than this test.
	deps := &Deps{Store: s, AgentPath: fakeSleeper(t)}
	srv2 := newTestServerWith(t, deps)
	token2, _ := bootstrapAdmin(t, srv2)

	_, started := call(t, srv2, "POST", "/api/workflow-runs", token2,
		map[string]any{"workflow_id": "wf1", "workspace_path": workspace})
	runID, _ := started["run_id"].(string)
	if runID == "" {
		t.Fatal("the run did not start")
	}

	// Wait for the agent to actually be in flight.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var n int
		s.DB().QueryRow(`SELECT COUNT(*) FROM agent_runs WHERE workflow_run_id = ? AND status = 'running'`, runID).Scan(&n)
		if n > 0 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}

	call(t, srv2, "POST", "/api/workflow-runs/"+runID+"/cancel", token2, nil)

	// The run must reach a terminal state QUICKLY — that is the proof the
	// subprocess was killed rather than left to finish.
	deadline = time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		var stepStatus string
		s.DB().QueryRow(
			`SELECT status FROM workflow_step_runs WHERE workflow_run_id = ? LIMIT 1`, runID).Scan(&stepStatus)
		if stepStatus != "" && stepStatus != "running" {
			if stepStatus != "cancelled" {
				t.Errorf("step status = %q, want cancelled", stepStatus)
			}
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Error("the step was still running 10s after cancel — the agent was not killed")
}

func TestCancelRequiresAdmin(t *testing.T) {
	srv, s := testServer(t)
	adminToken, _ := bootstrapAdmin(t, srv)
	seedRunWithStatus(t, s, "r1", "running")

	call(t, srv, "POST", "/api/auth/users", adminToken,
		map[string]string{"email": "op@local.dev", "password": "hunter2hunter2", "role": "operator"})
	_, login := call(t, srv, "POST", "/api/auth/login", "",
		map[string]string{"email": "op@local.dev", "password": "hunter2hunter2"})
	opToken, _ := login["token"].(string)

	if code, _ := call(t, srv, "POST", "/api/workflow-runs/r1/cancel", opToken, nil); code != http.StatusForbidden {
		t.Errorf("an operator cancelled a run (%d), want 403", code)
	}
	if code, _ := call(t, srv, "POST", "/api/workflow-runs/r1/cancel", "", nil); code != http.StatusUnauthorized {
		t.Errorf("an unauthenticated caller cancelled a run (%d), want 401", code)
	}
}

func TestCancellingAnUnknownRunIsNotAnError(t *testing.T) {
	// Cancelling something already gone is the caller getting what they wanted.
	srv, _ := testServer(t)
	token, _ := bootstrapAdmin(t, srv)
	if code, _ := call(t, srv, "POST", "/api/workflow-runs/ghost/cancel", token, nil); code != http.StatusOK {
		t.Errorf("got %d, want 200", code)
	}
}

// fakeSleeper is an agent that would outlast the test, so a step that reaches a
// terminal state can only have been killed.
func fakeSleeper(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "slow-agent")
	if err := os.WriteFile(path, []byte("#!/bin/sh\nsleep 120\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func newTestServerWith(t *testing.T, deps *Deps) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(NewRouter(deps))
	t.Cleanup(srv.Close)
	return srv
}
