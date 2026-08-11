// Tests for executing ONE node: the step rows it writes, and what it does when
// the agent fails, times out, or is cancelled.
//
// The agent is a real subprocess — a shell script standing in for `claude` —
// rather than a mock. What is being tested is the boundary between the runner
// and a process it does not control, and a mock cannot get that wrong in the
// ways a real process can.
//
// The row layout is not obvious and is easy to break: ONE step_id is written to
// BOTH workflow_step_runs and agent_runs. They are related by shared primary
// key, not by a foreign key, which is why the /steps endpoint LEFT JOINs on
// ws.id = ar.id. Writing separate ids would produce rows that look right in
// isolation and never join.
package runner

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/navjyotnishant/specter-agent/internal/graph"
	"github.com/navjyotnishant/specter-agent/internal/store"
)

// fakeAgent writes a script that behaves like an agent CLI and returns its path.
//
// It VERIFIES the script actually runs before handing back the path. A temp
// directory mounted noexec — which some CI runners do — leaves the script
// present, readable, and mode 0755, but silently unexecutable. The agent then
// produces no output, and every assertion downstream fails somewhere far from
// the cause: "the memory node wrote no memory", "the second node did not see
// the first node's output", a conditional taking the false branch on a reply of
// "YES". The tell is that the empty-reply case keeps passing, because empty is
// exactly what a script that never ran produces.
//
// Skipping beats failing here: an unexecutable temp dir is a property of the
// machine, not of the code under test.
func fakeAgent(t *testing.T, body string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "fake-agent")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	requireExecutableTempDir(t)
	return path
}

// requireExecutableTempDir checks ONCE per run that a script written to the
// temp directory can actually be executed.
//
// Probing with a trivial script rather than the caller's: several fake agents
// sleep or exit non-zero deliberately, so running each one an extra time to
// prove it starts took the package from 7s to 100s.
var tempDirExecutable = sync.OnceValue(func() error {
	dir, err := os.MkdirTemp("", "execcheck")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)

	probe := filepath.Join(dir, "probe")
	if err := os.WriteFile(probe, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		return err
	}
	return exec.Command(probe).Run()
})

func requireExecutableTempDir(t *testing.T) {
	t.Helper()
	if err := tempDirExecutable(); err != nil {
		if errors.Is(err, syscall.EACCES) || errors.Is(err, syscall.ENOEXEC) || errors.Is(err, os.ErrPermission) {
			t.Skipf("the temp directory is not executable (noexec?), so a fake agent cannot run: %v", err)
		}
		t.Fatalf("cannot execute a script from the temp directory: %v", err)
	}
}

func testRunner(t *testing.T) (*Runner, *store.Store, string) {
	t.Helper()
	s, err := store.Open(t.TempDir() + "/app.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })

	if _, err := s.DB().Exec(
		`INSERT INTO workflows (id, name, graph_json) VALUES ('wf1', 'Test', '{}')`); err != nil {
		t.Fatal(err)
	}
	runID := "run-1"
	if _, err := s.DB().Exec(
		`INSERT INTO workflow_runs (id, workflow_id, status, workspace_path, graph_json)
		 VALUES (?, 'wf1', 'running', ?, '{}')`, runID, t.TempDir()); err != nil {
		t.Fatal(err)
	}
	return &Runner{Store: s}, s, runID
}

func agentNode() graph.Node {
	return graph.Node{ID: "n1", Type: "specialistAgent",
		Data: graph.NodeData{Label: "Reviewer", Role: "security", Objective: "look"}}
}

func TestSuccessfulNodeWritesBothStepTables(t *testing.T) {
	r, s, runID := testRunner(t)
	r.AgentPath = fakeAgent(t, `echo "found nothing alarming"`)

	result := r.RunNode(context.Background(), runID, agentNode(), t.TempDir(), "")
	if result.Status != "completed" {
		t.Fatalf("status = %q, want completed (summary: %s)", result.Status, result.Summary)
	}

	// ONE id, BOTH tables — this is what makes the /steps LEFT JOIN work.
	var stepStatus, agentStatus, nodeType, agentName string
	if err := s.DB().QueryRow(
		`SELECT status, node_type FROM workflow_step_runs WHERE id = ?`, result.StepID).
		Scan(&stepStatus, &nodeType); err != nil {
		t.Fatalf("no workflow_step_runs row for the step id: %v", err)
	}
	if err := s.DB().QueryRow(
		`SELECT status, agent_name FROM agent_runs WHERE id = ?`, result.StepID).
		Scan(&agentStatus, &agentName); err != nil {
		t.Fatalf("no agent_runs row sharing the step id: %v", err)
	}
	if stepStatus != "completed" || agentStatus != "completed" {
		t.Errorf("statuses diverged: step=%q agent=%q", stepStatus, agentStatus)
	}
	if nodeType != "specialistAgent" {
		t.Errorf("node_type = %q", nodeType)
	}
	if agentName != "Reviewer" {
		t.Errorf("agent_name = %q, want the node label", agentName)
	}
}

func TestCompletedStepIsTerminal(t *testing.T) {
	// A step left at 'running' with no process behind it is the failure mode
	// that makes the UI spin forever.
	r, s, runID := testRunner(t)
	r.AgentPath = fakeAgent(t, `echo ok`)

	result := r.RunNode(context.Background(), runID, agentNode(), t.TempDir(), "")
	var completedAt *string
	s.DB().QueryRow(`SELECT completed_at FROM workflow_step_runs WHERE id = ?`, result.StepID).Scan(&completedAt)
	if completedAt == nil || *completedAt == "" {
		t.Error("completed_at was never stamped")
	}
}

func TestAgentOutputIsStoredAsAMessage(t *testing.T) {
	r, s, runID := testRunner(t)
	r.AgentPath = fakeAgent(t, `echo "the agent said this"`)

	result := r.RunNode(context.Background(), runID, agentNode(), t.TempDir(), "")
	var content string
	if err := s.DB().QueryRow(
		`SELECT content FROM agent_messages WHERE agent_run_id = ?`, result.StepID).Scan(&content); err != nil {
		t.Fatalf("no agent_messages row: %v", err)
	}
	if !strings.Contains(content, "the agent said this") {
		t.Errorf("message content = %q", content)
	}
}

func TestFailedAgentMarksTheStepFailedWithAnError(t *testing.T) {
	r, s, runID := testRunner(t)
	r.AgentPath = fakeAgent(t, `echo "something broke" >&2; exit 3`)

	result := r.RunNode(context.Background(), runID, agentNode(), t.TempDir(), "")
	if result.Status != "failed" {
		t.Fatalf("status = %q, want failed", result.Status)
	}

	var status string
	var errText *string
	s.DB().QueryRow(`SELECT status, error FROM agent_runs WHERE id = ?`, result.StepID).Scan(&status, &errText)
	if status != "failed" {
		t.Errorf("agent_runs status = %q", status)
	}
	if errText == nil || *errText == "" {
		t.Error("a failed step recorded no error — the UI would show a failure with no reason")
	}
}

func TestAMissingAgentBinaryFailsTheStepRatherThanPanicking(t *testing.T) {
	r, _, runID := testRunner(t)
	r.AgentPath = "/nonexistent/definitely-not-here"

	result := r.RunNode(context.Background(), runID, agentNode(), t.TempDir(), "")
	if result.Status != "failed" {
		t.Errorf("status = %q, want failed", result.Status)
	}
	if result.Summary == "" {
		t.Error("no summary explaining why it failed")
	}
}

func TestCancellationMarksTheStepCancelledNotFailed(t *testing.T) {
	// Cancelled and failed are different things to an operator: one they did,
	// one happened to them.
	r, s, runID := testRunner(t)
	r.AgentPath = fakeAgent(t, `sleep 30`)

	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(200 * time.Millisecond); cancel() }()

	result := r.RunNode(ctx, runID, agentNode(), t.TempDir(), "")
	if result.Status != "cancelled" {
		t.Fatalf("status = %q, want cancelled", result.Status)
	}
	var status string
	s.DB().QueryRow(`SELECT status FROM workflow_step_runs WHERE id = ?`, result.StepID).Scan(&status)
	if status != "cancelled" {
		t.Errorf("workflow_step_runs status = %q, want cancelled", status)
	}
}

func TestATimeoutIsAFailureWithAClearReason(t *testing.T) {
	r, _, runID := testRunner(t)
	r.AgentPath = fakeAgent(t, `sleep 30`)
	r.NodeTimeout = 300 * time.Millisecond

	result := r.RunNode(context.Background(), runID, agentNode(), t.TempDir(), "")
	if result.Status != "failed" {
		t.Fatalf("status = %q, want failed", result.Status)
	}
	if !strings.Contains(strings.ToLower(result.Summary), "time") {
		t.Errorf("summary %q does not mention the timeout", result.Summary)
	}
}

func TestTheRunGetsALogLineForEachNode(t *testing.T) {
	r, s, runID := testRunner(t)
	r.AgentPath = fakeAgent(t, `echo ok`)
	r.RunNode(context.Background(), runID, agentNode(), t.TempDir(), "")

	rows, err := s.DB().Query(`SELECT message FROM run_logs WHERE workflow_run_id = ? ORDER BY created_at`, runID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var messages []string
	for rows.Next() {
		var m string
		rows.Scan(&m)
		messages = append(messages, m)
	}
	joined := strings.Join(messages, " | ")
	if !strings.Contains(joined, "Starting node") {
		t.Errorf("no start log: %s", joined)
	}
	if !strings.Contains(joined, "Reviewer") {
		t.Errorf("logs do not name the node: %s", joined)
	}
}

func TestASuccessfulNodeWritesMemory(t *testing.T) {
	// Later nodes read this as background. Without it each node starts blind.
	r, s, runID := testRunner(t)
	r.AgentPath = fakeAgent(t, `echo "the finding"`)
	result := r.RunNode(context.Background(), runID, agentNode(), t.TempDir(), "")

	var key, value string
	if err := s.DB().QueryRow(
		`SELECT key, value_text FROM memory_entries WHERE workflow_run_id = ? AND agent_run_id = ?`,
		runID, result.StepID).Scan(&key, &value); err != nil {
		t.Fatalf("no memory entry: %v", err)
	}
	if key != "Reviewer" {
		t.Errorf("memory key = %q, want the node label", key)
	}
	if value == "" {
		t.Error("memory value is empty")
	}
}

func TestAFailedNodeWritesNoMemory(t *testing.T) {
	// Writing a failure into memory feeds it to every later node as background.
	r, s, runID := testRunner(t)
	r.AgentPath = fakeAgent(t, `exit 1`)
	r.RunNode(context.Background(), runID, agentNode(), t.TempDir(), "")

	var n int
	s.DB().QueryRow(`SELECT COUNT(*) FROM memory_entries WHERE workflow_run_id = ?`, runID).Scan(&n)
	if n != 0 {
		t.Errorf("a failed node wrote %d memory entries", n)
	}
}

func TestTheAgentRunsInTheWorkspace(t *testing.T) {
	// A node that ran in the wrong directory reviews the wrong repository.
	r, _, runID := testRunner(t)
	workspace := t.TempDir()
	r.AgentPath = fakeAgent(t, `pwd`)

	result := r.RunNode(context.Background(), runID, agentNode(), workspace, "")
	if result.Status != "completed" {
		t.Fatalf("status = %q", result.Status)
	}
	// macOS reports /private/var for /var, so compare resolved paths.
	resolved, _ := filepath.EvalSymlinks(workspace)
	if !strings.Contains(result.Stdout, resolved) && !strings.Contains(result.Stdout, workspace) {
		t.Errorf("agent ran in the wrong directory: %q, want %q", strings.TrimSpace(result.Stdout), workspace)
	}
}
