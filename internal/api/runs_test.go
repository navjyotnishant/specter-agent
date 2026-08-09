// Tests for the run READ surface: list, get, steps, logs, messages, stats.
//
// Starting a run and resolving an approval both resume execution through the
// engine, so they are not in this pass — they need internal/exec wired in, and
// half a start endpoint is worse than none.
//
// The stats endpoint is the subtle one. Every field on it exists because a
// simpler version misled someone:
//
//	aggregates in SQL, not over a page  counting from a truncated list is how
//	                                    the banner reported "All clear" while
//	                                    failures sat outside the loaded window
//	active counted with NO window       a run started two days ago and still
//	                                    going is exactly what an operator needs
//	oldest_active_started_at            "3 running" says nothing about whether
//	                                    one has been stuck for an hour
//	median_delta_seconds                null unless BOTH windows have data — a
//	                                    trend computed against nothing is an
//	                                    invented number
package api

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/navjyotnishant/specter-agent/internal/store"
)

// seedRun inserts a run directly. Runs are created by the engine, not by this
// API, so tests seed rather than POST.
func seedRun(t *testing.T, s *store.Store, id, workflowID, status string, createdOffset, completedOffset string) {
	t.Helper()
	// The Go store enables foreign_keys (Python's connection does not), so the
	// parent workflow has to exist. Insert-or-ignore keeps the helper callable
	// repeatedly for the same workflow.
	if _, err := s.DB().Exec(
		`INSERT OR IGNORE INTO workflows (id, name, graph_json) VALUES (?, ?, '{}')`,
		workflowID, "wf-"+workflowID); err != nil {
		t.Fatalf("seeding workflow %s: %v", workflowID, err)
	}
	var completed any
	if completedOffset != "" {
		completed = fmt.Sprintf("datetime('now', '%s')", completedOffset)
	}
	query := fmt.Sprintf(
		`INSERT INTO workflow_runs (id, workflow_id, status, trigger_type, workspace_path, graph_json, created_at, completed_at)
		 VALUES (?, ?, ?, 'manual', '/repo', '{"nodes":[]}', datetime('now', '%s'), %s)`,
		createdOffset, ifEmpty(completed, "NULL"))
	if _, err := s.DB().Exec(query, id, workflowID, status); err != nil {
		t.Fatalf("seeding run %s: %v", id, err)
	}
}

func ifEmpty(v any, fallback string) string {
	if v == nil {
		return fallback
	}
	return v.(string)
}

func TestRunReadSurface(t *testing.T) {
	srv, s := testServer(t)
	token, _ := bootstrapAdmin(t, srv)

	seedRun(t, s, "r1", "wf1", "completed", "-1 hours", "-50 minutes")
	// A "step" in the UI is the agent_run; workflow_step_runs contributes only
	// node_type, and the two share an id.
	if _, err := s.DB().Exec(
		`INSERT INTO workflow_step_runs (id, workflow_run_id, node_id, node_type, status)
		 VALUES ('s1', 'r1', 'n1', 'agent', 'completed')`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB().Exec(
		`INSERT INTO run_logs (id, workflow_run_id, level, message, metadata_json)
		 VALUES ('l1', 'r1', 'info', 'started', '{"k":"v"}')`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB().Exec(
		`INSERT INTO agent_runs (id, workflow_run_id, node_id, agent_name, agent_role, status, summary)
		 VALUES ('s1', 'r1', 'n1', 'claude', 'reviewer', 'completed', 'looked fine')`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB().Exec(
		`INSERT INTO agent_messages (id, agent_run_id, sender_type, sender_name, content)
		 VALUES ('m1', 's1', 'agent', 'claude', 'done')`); err != nil {
		t.Fatal(err)
	}

	code, run := call(t, srv, "GET", "/api/workflow-runs/r1", token, nil)
	if code != http.StatusOK {
		t.Fatalf("get run returned %d", code)
	}
	if run["status"] != "completed" || run["workflow_id"] != "wf1" {
		t.Errorf("wrong run: %+v", run)
	}
	// graph comes back DECODED, matching _public_run.
	if _, ok := run["graph"].(map[string]any); !ok {
		t.Errorf("graph is not an object: %T", run["graph"])
	}

	steps := callArray(t, srv, "GET", "/api/workflow-runs/r1/steps", token)
	if len(steps) != 1 || steps[0]["summary"] != "looked fine" {
		t.Errorf("steps wrong: %+v", steps)
	}

	logs := callArray(t, srv, "GET", "/api/workflow-runs/r1/logs", token)
	if len(logs) != 1 {
		t.Fatalf("expected 1 log, got %d", len(logs))
	}
	// metadata is decoded from metadata_json, and the field is renamed.
	if md, ok := logs[0]["metadata"].(map[string]any); !ok || md["k"] != "v" {
		t.Errorf("log metadata not decoded: %+v", logs[0])
	}

	msgs := callArray(t, srv, "GET", "/api/workflow-runs/r1/steps/s1/messages", token)
	if len(msgs) != 1 || msgs[0]["content"] != "done" {
		t.Errorf("messages wrong: %+v", msgs)
	}
}

func TestRunListIsNewestFirstAndFilterable(t *testing.T) {
	srv, s := testServer(t)
	token, _ := bootstrapAdmin(t, srv)

	seedRun(t, s, "old", "wf1", "completed", "-3 hours", "-2 hours")
	seedRun(t, s, "mid", "wf2", "completed", "-2 hours", "-1 hours")
	seedRun(t, s, "new", "wf1", "running", "-1 hours", "")

	all := callArray(t, srv, "GET", "/api/workflow-runs", token)
	if len(all) != 3 {
		t.Fatalf("got %d runs, want 3", len(all))
	}
	if all[0]["id"] != "new" || all[2]["id"] != "old" {
		t.Errorf("not newest-first: %v, %v, %v", all[0]["id"], all[1]["id"], all[2]["id"])
	}

	filtered := callArray(t, srv, "GET", "/api/workflow-runs?workflow_id=wf1", token)
	if len(filtered) != 2 {
		t.Errorf("workflow_id filter returned %d, want 2", len(filtered))
	}
}

func TestRunListLimitIsCallerVisibleAndClamped(t *testing.T) {
	// The limit is an explicit parameter rather than a hidden 20: callers were
	// treating a truncated page as a total, so a dashboard tile froze at 20 once
	// the 21st run existed.
	srv, s := testServer(t)
	token, _ := bootstrapAdmin(t, srv)
	for i := 0; i < 5; i++ {
		seedRun(t, s, fmt.Sprintf("r%d", i), "wf1", "completed", fmt.Sprintf("-%d hours", 5-i), "-1 hours")
	}

	if got := callArray(t, srv, "GET", "/api/workflow-runs?limit=2", token); len(got) != 2 {
		t.Errorf("limit=2 returned %d", len(got))
	}
	// Clamped to [1, 500] rather than rejected.
	if got := callArray(t, srv, "GET", "/api/workflow-runs?limit=0", token); len(got) != 1 {
		t.Errorf("limit=0 should clamp to 1, got %d", len(got))
	}
	if got := callArray(t, srv, "GET", "/api/workflow-runs?limit=99999", token); len(got) != 5 {
		t.Errorf("limit=99999 should clamp to 500, got %d", len(got))
	}
}

func TestStatsCountsTheWholeTableNotAPage(t *testing.T) {
	srv, s := testServer(t)
	token, _ := bootstrapAdmin(t, srv)

	for i := 0; i < 3; i++ {
		seedRun(t, s, fmt.Sprintf("ok%d", i), "wf1", "completed", "-2 hours", "-1 hours")
	}
	seedRun(t, s, "bad", "wf1", "failed", "-2 hours", "-1 hours")
	seedRun(t, s, "live", "wf1", "running", "-30 minutes", "")

	_, stats := call(t, srv, "GET", "/api/workflow-runs/stats", token, nil)
	if stats["total"] != float64(5) {
		t.Errorf("total = %v, want 5", stats["total"])
	}
	if stats["completed"] != float64(3) {
		t.Errorf("completed = %v, want 3", stats["completed"])
	}
	if stats["failed"] != float64(1) {
		t.Errorf("failed = %v, want 1", stats["failed"])
	}
	if stats["active"] != float64(1) {
		t.Errorf("active = %v, want 1", stats["active"])
	}
	if stats["oldest_active_started_at"] == nil {
		t.Error("oldest_active_started_at is null with a run in flight — " +
			"\"1 running\" says nothing about whether it has been stuck for an hour")
	}
}

func TestActiveRunsAreCountedOutsideTheWindow(t *testing.T) {
	// A run started two days ago and still going is exactly what an operator
	// needs to see, so `active` deliberately ignores window_hours.
	srv, s := testServer(t)
	token, _ := bootstrapAdmin(t, srv)
	seedRun(t, s, "ancient", "wf1", "running", "-72 hours", "")

	_, stats := call(t, srv, "GET", "/api/workflow-runs/stats?window_hours=1", token, nil)
	if stats["total"] != float64(0) {
		t.Errorf("total = %v — the run is outside the 1h window", stats["total"])
	}
	if stats["active"] != float64(1) {
		t.Errorf("active = %v, want 1 — a long-running run must not vanish from the count", stats["active"])
	}
}

func TestMedianDeltaIsNullUnlessBothWindowsHaveData(t *testing.T) {
	// A trend computed against nothing is an invented number. Guarding only the
	// previous window let an empty CURRENT window report "81s faster".
	srv, s := testServer(t)
	token, _ := bootstrapAdmin(t, srv)

	// Only the current window has data.
	seedRun(t, s, "recent", "wf1", "completed", "-2 hours", "-1 hours")
	_, stats := call(t, srv, "GET", "/api/workflow-runs/stats?window_hours=24", token, nil)
	if stats["median_duration_seconds"] == nil {
		t.Error("median_duration_seconds is null with a completed run in the window")
	}
	if stats["median_delta_seconds"] != nil {
		t.Errorf("median_delta_seconds = %v with no previous-window data — that trend is invented",
			stats["median_delta_seconds"])
	}
}

func TestStatsOnAnEmptyTableReportsZerosNotNulls(t *testing.T) {
	srv, _ := testServer(t)
	token, _ := bootstrapAdmin(t, srv)
	_, stats := call(t, srv, "GET", "/api/workflow-runs/stats", token, nil)

	for _, field := range []string{"total", "failed", "completed", "active", "waiting_approval"} {
		if stats[field] != float64(0) {
			t.Errorf("%s = %v on an empty table, want 0", field, stats[field])
		}
	}
	if stats["median_duration_seconds"] != nil {
		t.Errorf("median = %v with no completed runs, want null", stats["median_duration_seconds"])
	}
}

func TestRunNotFoundIs404(t *testing.T) {
	srv, _ := testServer(t)
	token, _ := bootstrapAdmin(t, srv)
	if code, _ := call(t, srv, "GET", "/api/workflow-runs/nope", token, nil); code != http.StatusNotFound {
		t.Errorf("got %d, want 404", code)
	}
}

// /stats must not be shadowed by /{run_id} — a router that matches the wildcard
// first turns the dashboard's stats call into a 404 for a run named "stats".
func TestStatsIsNotShadowedByTheRunIDRoute(t *testing.T) {
	srv, _ := testServer(t)
	token, _ := bootstrapAdmin(t, srv)
	code, body := call(t, srv, "GET", "/api/workflow-runs/stats", token, nil)
	if code != http.StatusOK {
		t.Fatalf("/stats returned %d — the {run_id} route is shadowing it", code)
	}
	if _, ok := body["total"]; !ok {
		t.Errorf("/stats returned a run, not stats: %+v", body)
	}
}

func TestRunsRequireAuth(t *testing.T) {
	srv, _ := testServer(t)
	bootstrapAdmin(t, srv)
	for _, path := range []string{
		"/api/workflow-runs", "/api/workflow-runs/stats", "/api/workflow-runs/r1",
		"/api/workflow-runs/r1/steps", "/api/workflow-runs/r1/logs",
	} {
		if code, _ := call(t, srv, "GET", path, "", nil); code != http.StatusUnauthorized {
			t.Errorf("GET %s without a token returned %d", path, code)
		}
	}
}
