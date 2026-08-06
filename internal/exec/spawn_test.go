package exec

import (
	"context"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// Ported from specter_exec/spawn.py --self-check.

func TestSpawnBasics(t *testing.T) {
	dir := t.TempDir()

	t.Run("captures stdout and reports success", func(t *testing.T) {
		got := RunStreaming(context.Background(), Command{
			Argv: []string{"echo", "hello"}, Dir: dir, Timeout: 10 * time.Second,
		})
		if got.Stdout != "hello" {
			t.Fatalf("stdout = %q", got.Stdout)
		}
		if !got.OK() || got.ExitCode != 0 {
			t.Fatalf("want ok, got exit=%d err=%q", got.ExitCode, got.Err)
		}
	})

	t.Run("captures a non-zero exit", func(t *testing.T) {
		got := RunStreaming(context.Background(), Command{
			Argv: []string{"sh", "-c", "exit 3"}, Dir: dir, Timeout: 10 * time.Second,
		})
		if got.ExitCode != 3 || got.OK() {
			t.Fatalf("want exit 3 and not-ok, got exit=%d ok=%v", got.ExitCode, got.OK())
		}
	})

	t.Run("captures stderr separately", func(t *testing.T) {
		got := RunStreaming(context.Background(), Command{
			Argv: []string{"sh", "-c", "echo oops >&2"}, Dir: dir, Timeout: 10 * time.Second,
		})
		if got.Stderr != "oops" {
			t.Fatalf("stderr = %q", got.Stderr)
		}
	})

	t.Run("streams each line as it arrives", func(t *testing.T) {
		var seen []string
		RunStreaming(context.Background(), Command{
			Argv: []string{"sh", "-c", "echo one; echo two"}, Dir: dir,
			Timeout: 10 * time.Second, OnStdout: func(s string) { seen = append(seen, s) },
		})
		if len(seen) != 2 || seen[0] != "one" || seen[1] != "two" {
			t.Fatalf("streamed %v", seen)
		}
	})
}

// THE DEADLOCK CASE. A subprocess writing more to stderr than the pipe buffer
// holds blocks forever while the parent reads stdout. Draining both concurrently
// is what stops a chatty agent hanging a run.
func TestChattyStderrDoesNotDeadlock(t *testing.T) {
	got := RunStreaming(context.Background(), Command{
		Argv: []string{"sh", "-c",
			`i=0; while [ $i -lt 20000 ]; do echo "noise line $i" >&2; i=$((i+1)); done; echo done`},
		Dir: t.TempDir(), Timeout: 30 * time.Second,
	})
	if got.ExitCode != 0 {
		t.Fatalf("want clean exit, got %d (err %q)", got.ExitCode, got.Err)
	}
	if !strings.Contains(got.Stdout, "done") {
		t.Fatal("stdout lost while stderr was draining")
	}
}

// A timeout that waits for the command to finish is not a timeout.
func TestDeadlineKillsRatherThanWaits(t *testing.T) {
	start := time.Now()
	got := RunStreaming(context.Background(), Command{
		Argv:    []string{"sh", "-c", "for i in 1 2 3 4 5 6 7 8; do echo tick; sleep 1; done"},
		Dir:     t.TempDir(),
		Timeout: 2 * time.Second,
	})
	elapsed := time.Since(start)

	if !got.TimedOut {
		t.Fatal("overrunning must be reported as a timeout")
	}
	if got.OK() {
		t.Fatal("a timed-out run is not ok")
	}
	if elapsed > 6*time.Second {
		t.Fatalf("must not wait for the full command, took %s", elapsed)
	}
}

// A missing binary is an outcome, not an exception for the caller to handle
// separately: "claude is not installed" and "claude exited 1" are reported the
// same way.
func TestMissingBinaryIsAResult(t *testing.T) {
	got := RunStreaming(context.Background(), Command{
		Argv: []string{"definitely-not-a-real-binary-xyz"}, Dir: t.TempDir(), Timeout: 5 * time.Second,
	})
	if got.Err == "" {
		t.Fatal("a missing binary must set Err")
	}
	if got.OK() {
		t.Fatal("and must not be ok")
	}
}

// Cancellation must work while the run is in flight, not only at the deadline.
// This is what stops a stuck agent becoming a stuck Specter.
func TestContextCancellationStopsTheRun(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(300 * time.Millisecond)
		cancel()
	}()

	start := time.Now()
	got := RunStreaming(ctx, Command{
		Argv:    []string{"sh", "-c", "for i in 1 2 3 4 5 6 7 8 9 10; do echo tick; sleep 1; done"},
		Dir:     t.TempDir(),
		Timeout: 60 * time.Second,
	})
	elapsed := time.Since(start)

	if got.OK() {
		t.Fatal("a cancelled run is not ok")
	}
	if elapsed > 5*time.Second {
		t.Fatalf("cancel must stop it promptly, took %s", elapsed)
	}
}

func TestExitCodeSurvivesLookPathSuccess(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("sh unavailable")
	}
	got := RunStreaming(context.Background(), Command{
		Argv: []string{"sh", "-c", "exit 0"}, Dir: t.TempDir(), Timeout: 5 * time.Second,
	})
	if !got.OK() {
		t.Fatalf("want ok, got %+v", got)
	}
}
