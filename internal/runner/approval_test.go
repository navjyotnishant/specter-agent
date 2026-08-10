// R4: humanApproval — suspend, resume, reject, and expiry.
//
// Each test below maps to a way a run gets STRANDED, which is the failure class
// that matters here: a stranded run shows an approved gate on a dead workflow,
// or re-runs work an agent already did.
//
// Resume is not a special path. The main loop skips nodes whose latest step is
// already 'completed' and folds their summaries back into context, so a
// re-started run walks back to the gate and continues past it. That is why R1-R3
// already contained most of this.
package runner

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/navjyotnishant/specter-agent/internal/graph"
	"github.com/navjyotnishant/specter-agent/internal/store"
)

func gate(id, label string) graph.Node {
	return graph.Node{ID: id, Type: "humanApproval",
		Data: graph.NodeData{Label: label, Reason: "check before writing"}}
}

// resolveApproval simulates the API endpoint a human would hit.
func resolveApproval(t *testing.T, s *store.Store, runID, status string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		res, err := s.DB().Exec(
			`UPDATE approval_requests SET status = ?, resolved_at = CURRENT_TIMESTAMP
			  WHERE workflow_run_id = ? AND status = 'pending'`, status, runID)
		if err == nil {
			if n, _ := res.RowsAffected(); n > 0 {
				return
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("no pending approval appeared for run %s", runID)
}

func TestAGateSuspendsTheRunAndRecordsAnApproval(t *testing.T) {
	r, s, runID := testRunner(t)
	r.AgentPath = fakeAgent(t, `echo ok`)
	r.ApprovalPoll = 20 * time.Millisecond

	g := graph.Graph{
		Nodes: []graph.Node{agent("n1", "First"), gate("g1", "Sign off")},
		Edges: []graph.Edge{{ID: "e1", Source: "n1", Target: "g1"}},
	}

	done := make(chan struct{})
	go func() { r.RunWorkflow(context.Background(), runID, "wf1", g, t.TempDir(), nil); close(done) }()

	// The gate must be visible to a human before anything else happens.
	deadline := time.Now().Add(5 * time.Second)
	var title, status string
	for time.Now().Before(deadline) {
		err := s.DB().QueryRow(
			`SELECT title, status FROM approval_requests WHERE workflow_run_id = ?`, runID).Scan(&title, &status)
		if err == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if status != "pending" {
		t.Fatalf("no pending approval was created (status %q)", status)
	}
	if title != "Sign off" {
		t.Errorf("approval title = %q, want the node label", title)
	}
	if got := runStatus(t, s, runID); got != "waiting_approval" {
		t.Errorf("run status = %q, want waiting_approval", got)
	}

	resolveApproval(t, s, runID, "approved")
	<-done
	if got := runStatus(t, s, runID); got != "completed" {
		t.Errorf("run status after approval = %q, want completed", got)
	}
}

func TestApprovalCarriesAnExpiry(t *testing.T) {
	// Without one a forgotten gate holds a run open forever.
	r, s, runID := testRunner(t)
	r.AgentPath = fakeAgent(t, `echo ok`)
	r.ApprovalPoll = 20 * time.Millisecond

	g := graph.Graph{Nodes: []graph.Node{gate("g1", "Sign off")}}
	go r.RunWorkflow(context.Background(), runID, "wf1", g, t.TempDir(), nil)

	deadline := time.Now().Add(5 * time.Second)
	var expires *string
	for time.Now().Before(deadline) {
		if err := s.DB().QueryRow(
			`SELECT expires_at FROM approval_requests WHERE workflow_run_id = ?`, runID).Scan(&expires); err == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if expires == nil || *expires == "" {
		t.Fatal("the approval has no expiry")
	}
	resolveApproval(t, s, runID, "rejected")
}

func TestARejectedApprovalStopsTheRun(t *testing.T) {
	r, s, runID := testRunner(t)
	r.AgentPath = fakeAgent(t, `echo ok`)
	r.ApprovalPoll = 20 * time.Millisecond

	g := graph.Graph{
		Nodes: []graph.Node{gate("g1", "Sign off"), agent("n2", "AfterGate")},
		Edges: []graph.Edge{{ID: "e1", Source: "g1", Target: "n2"}},
	}
	done := make(chan struct{})
	go func() { r.RunWorkflow(context.Background(), runID, "wf1", g, t.TempDir(), nil); close(done) }()

	resolveApproval(t, s, runID, "rejected")
	<-done

	if got := runStatus(t, s, runID); got != "failed" {
		t.Errorf("run status = %q, want failed", got)
	}
	// The node behind the gate must NOT have run — that is the whole point.
	var n int
	s.DB().QueryRow(`SELECT COUNT(*) FROM agent_runs WHERE workflow_run_id = ? AND node_id = 'n2'`, runID).Scan(&n)
	if n != 0 {
		t.Error("the node behind a rejected gate executed anyway")
	}
	// And the gate's own step must be terminal, not left waiting.
	var stepStatus string
	s.DB().QueryRow(
		`SELECT status FROM workflow_step_runs WHERE workflow_run_id = ? AND node_id = 'g1'`, runID).Scan(&stepStatus)
	if stepStatus == "waiting_approval" || stepStatus == "running" {
		t.Errorf("the gate step was left at %q", stepStatus)
	}
}

func TestRevisionRequestedAlsoStopsTheRun(t *testing.T) {
	r, s, runID := testRunner(t)
	r.AgentPath = fakeAgent(t, `echo ok`)
	r.ApprovalPoll = 20 * time.Millisecond

	g := graph.Graph{Nodes: []graph.Node{gate("g1", "Sign off")}}
	done := make(chan struct{})
	go func() { r.RunWorkflow(context.Background(), runID, "wf1", g, t.TempDir(), nil); close(done) }()

	resolveApproval(t, s, runID, "revision_requested")
	<-done
	if got := runStatus(t, s, runID); got != "failed" {
		t.Errorf("run status = %q, want failed", got)
	}
}

func TestAnExpiredApprovalCancelsTheRun(t *testing.T) {
	// Cancelled, not failed: nothing went wrong, nobody answered.
	r, s, runID := testRunner(t)
	r.AgentPath = fakeAgent(t, `echo ok`)
	r.ApprovalPoll = 20 * time.Millisecond
	// A gate that has already expired by the time it is written.
	r.ApprovalTimeout = -time.Hour

	g := graph.Graph{Nodes: []graph.Node{gate("g1", "Sign off")}}
	done := make(chan struct{})
	go func() { r.RunWorkflow(context.Background(), runID, "wf1", g, t.TempDir(), nil); close(done) }()

	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("an already-expired gate did not resolve — the run would hang forever")
	}

	if got := runStatus(t, s, runID); got != "cancelled" {
		t.Errorf("run status = %q, want cancelled", got)
	}
	var approvalStatus string
	s.DB().QueryRow(
		`SELECT status FROM approval_requests WHERE workflow_run_id = ?`, runID).Scan(&approvalStatus)
	if approvalStatus != "expired" {
		t.Errorf("approval status = %q, want expired", approvalStatus)
	}
}

// STRANDING MODE 1: resuming re-runs work an agent already did.
func TestResumingDoesNotReRunCompletedWork(t *testing.T) {
	r, s, runID := testRunner(t)
	r.ApprovalPoll = 20 * time.Millisecond
	// Any execution of n1 would fail loudly, proving it was NOT re-run.
	r.AgentPath = fakeAgent(t, `echo "SHOULD NOT RUN"; exit 1`)

	// The state a restart leaves behind: n1 done, the gate waiting, approved.
	if _, err := s.DB().Exec(
		`INSERT INTO workflow_step_runs (id, workflow_run_id, node_id, node_type, status, completed_at)
		 VALUES ('s1', ?, 'n1', 'specialistAgent', 'completed', '2026-01-01 00:00:00')`, runID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB().Exec(
		`INSERT INTO agent_runs (id, workflow_run_id, node_id, agent_name, agent_role, status, summary, completed_at)
		 VALUES ('s1', ?, 'n1', 'First', 'reviewer', 'completed', 'ALREADY-DONE', '2026-01-01 00:00:00')`,
		runID); err != nil {
		t.Fatal(err)
	}

	g := graph.Graph{
		Nodes: []graph.Node{agent("n1", "First"), gate("g1", "Sign off")},
		Edges: []graph.Edge{{ID: "e1", Source: "n1", Target: "g1"}},
	}
	done := make(chan struct{})
	go func() { r.RunWorkflow(context.Background(), runID, "wf1", g, t.TempDir(), nil); close(done) }()

	resolveApproval(t, s, runID, "approved")
	<-done

	var n1Runs int
	s.DB().QueryRow(
		`SELECT COUNT(*) FROM agent_runs WHERE workflow_run_id = ? AND node_id = 'n1'`, runID).Scan(&n1Runs)
	if n1Runs != 1 {
		t.Errorf("n1 has %d agent_runs rows — a completed node was re-run, so an agent that "+
			"already wrote files would write them twice", n1Runs)
	}
	if got := runStatus(t, s, runID); got != "completed" {
		t.Errorf("run status = %q, want completed", got)
	}
}

// STRANDING MODE 2: an already-approved gate on a restarted run must not wait
// for a second approval that will never come.
func TestAnAlreadyApprovedGateContinuesImmediately(t *testing.T) {
	r, s, runID := testRunner(t)
	r.AgentPath = fakeAgent(t, `echo ok`)
	// Deliberately slow: if the gate waits at all, the test times out.
	r.ApprovalPoll = 30 * time.Second

	if _, err := s.DB().Exec(
		`INSERT INTO workflow_step_runs (id, workflow_run_id, node_id, node_type, status)
		 VALUES ('sg', ?, 'g1', 'humanApproval', 'waiting_approval')`, runID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB().Exec(
		`INSERT INTO agent_runs (id, workflow_run_id, node_id, agent_name, agent_role, status)
		 VALUES ('sg', ?, 'g1', 'Sign off', 'humanApproval', 'waiting_approval')`, runID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB().Exec(
		`INSERT INTO approval_requests (id, workflow_run_id, workflow_step_run_id, status, title, reason)
		 VALUES ('a1', ?, 'sg', 'approved', 'Sign off', 'check')`, runID); err != nil {
		t.Fatal(err)
	}

	g := graph.Graph{Nodes: []graph.Node{gate("g1", "Sign off")}}
	done := make(chan struct{})
	go func() { r.RunWorkflow(context.Background(), runID, "wf1", g, t.TempDir(), nil); close(done) }()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("an already-approved gate waited for a second approval that will never come")
	}
	if got := runStatus(t, s, runID); got != "completed" {
		t.Errorf("run status = %q, want completed", got)
	}
}

// STRANDING MODE 3: approving an already-expired gate must not resurrect a run
// the expiry already cancelled.
func TestApprovingAnExpiredGateDoesNotResurrectTheRun(t *testing.T) {
	r, s, runID := testRunner(t)
	r.AgentPath = fakeAgent(t, `echo "SHOULD NOT RUN"; exit 1`)
	r.ApprovalPoll = 20 * time.Millisecond

	if _, err := s.DB().Exec(
		`INSERT INTO workflow_step_runs (id, workflow_run_id, node_id, node_type, status)
		 VALUES ('sg', ?, 'g1', 'humanApproval', 'cancelled')`, runID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB().Exec(
		`INSERT INTO agent_runs (id, workflow_run_id, node_id, agent_name, agent_role, status)
		 VALUES ('sg', ?, 'g1', 'Sign off', 'humanApproval', 'cancelled')`, runID); err != nil {
		t.Fatal(err)
	}
	// Expired, then approved anyway — a late click on a stale UI.
	if _, err := s.DB().Exec(
		`INSERT INTO approval_requests (id, workflow_run_id, workflow_step_run_id, status, title, reason, expires_at)
		 VALUES ('a1', ?, 'sg', 'expired', 'Sign off', 'check', '2020-01-01T00:00:00+00:00')`, runID); err != nil {
		t.Fatal(err)
	}
	s.DB().Exec(`UPDATE workflow_runs SET status = 'cancelled' WHERE id = ?`, runID)

	g := graph.Graph{
		Nodes: []graph.Node{gate("g1", "Sign off"), agent("n2", "AfterGate")},
		Edges: []graph.Edge{{ID: "e1", Source: "g1", Target: "n2"}},
	}
	done := make(chan struct{})
	go func() { r.RunWorkflow(context.Background(), runID, "wf1", g, t.TempDir(), nil); close(done) }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("the run hung on an expired gate")
	}

	var n int
	s.DB().QueryRow(`SELECT COUNT(*) FROM agent_runs WHERE workflow_run_id = ? AND node_id = 'n2'`, runID).Scan(&n)
	if n != 0 {
		t.Error("a node behind an EXPIRED gate executed — the expiry already cancelled this run")
	}
}

func TestCancellingAWaitingRunReleasesTheGate(t *testing.T) {
	// Otherwise cancel appears to do nothing until the gate is answered.
	r, s, runID := testRunner(t)
	r.AgentPath = fakeAgent(t, `echo ok`)
	r.ApprovalPoll = 20 * time.Millisecond

	g := graph.Graph{Nodes: []graph.Node{gate("g1", "Sign off")}}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { r.RunWorkflow(ctx, runID, "wf1", g, t.TempDir(), nil); close(done) }()

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var n int
		s.DB().QueryRow(`SELECT COUNT(*) FROM approval_requests WHERE workflow_run_id = ?`, runID).Scan(&n)
		if n > 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	cancel()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("cancelling a run waiting on approval did not release it")
	}
	if got := runStatus(t, s, runID); got != "cancelled" {
		t.Errorf("run status = %q, want cancelled", got)
	}
}

func TestTheGateReasonReachesTheApproval(t *testing.T) {
	// A reviewer approving a gate with no stated reason is approving nothing in
	// particular.
	r, s, runID := testRunner(t)
	r.AgentPath = fakeAgent(t, `echo ok`)
	r.ApprovalPoll = 20 * time.Millisecond

	node := graph.Node{ID: "g1", Type: "humanApproval",
		Data: graph.NodeData{Label: "Deploy?", Reason: "this writes to production"}}
	g := graph.Graph{Nodes: []graph.Node{node}}
	done := make(chan struct{})
	go func() { r.RunWorkflow(context.Background(), runID, "wf1", g, t.TempDir(), nil); close(done) }()

	deadline := time.Now().Add(5 * time.Second)
	var reason string
	for time.Now().Before(deadline) {
		if err := s.DB().QueryRow(
			`SELECT reason FROM approval_requests WHERE workflow_run_id = ?`, runID).Scan(&reason); err == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !strings.Contains(reason, "production") {
		t.Errorf("approval reason = %q, want the node's configured reason", reason)
	}
	resolveApproval(t, s, runID, "rejected")
	<-done
}
