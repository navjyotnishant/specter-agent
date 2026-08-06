package confine

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/navjyotnishant/specter-agent/internal/exec"
)

// Real enforcement, not advisory text. Every test here runs a real command under
// a real profile — a confinement layer verified only by reading its own config
// is exactly the failure this is meant to prevent.

func requireMacOS(t *testing.T) {
	t.Helper()
	if runtime.GOOS != "darwin" {
		t.Skip("sandbox-exec is macOS only")
	}
	if _, err := os.Stat(sandboxExec); err != nil {
		t.Skip("sandbox-exec unavailable")
	}
}

// THE TRAP. sandbox-exec matches on RESOLVED paths. /tmp is a symlink to
// /private/tmp, so a profile written with the unresolved path silently allows
// everything it meant to deny — no error, no warning, no protection.
//
// This is how a security feature ships and protects nothing.
func TestProfileUsesResolvedPaths(t *testing.T) {
	requireMacOS(t)

	dir := t.TempDir() // /var/... which resolves to /private/var/...
	resolved, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}
	if dir == resolved {
		t.Skip("no symlink in this temp path; the trap cannot be demonstrated here")
	}

	profile, err := macOSProfile(dir)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(profile, `"`+dir+`"`) {
		t.Fatal("profile embedded the UNRESOLVED path — it would fail open")
	}
	if !strings.Contains(profile, resolved) {
		t.Fatal("profile must embed the resolved path")
	}
}

// A path containing a quote or paren breaks out of the s-expression and can
// rewrite the policy. Rejected rather than escaped.
func TestProfileRejectsUnsafePaths(t *testing.T) {
	for _, bad := range []string{`/tmp/we"ird`, `/tmp/we)ird`, `/tmp/we(ird`} {
		if _, err := macOSProfile(bad); err == nil {
			t.Fatalf("path %q must be rejected", bad)
		}
	}
}

func TestWritesInsideTheWorkspaceSucceed(t *testing.T) {
	requireMacOS(t)
	dir := t.TempDir()

	target := filepath.Join(dir, "allowed.txt")
	result := runConfined(t, dir, "sh", "-c", "echo ok > "+target)

	if !result.OK() {
		t.Fatalf("a write inside the workspace must succeed: %s", result.Stderr)
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatalf("the file was not written: %v", err)
	}
}

// The point of the whole layer.
func TestWritesOutsideTheWorkspaceAreDenied(t *testing.T) {
	requireMacOS(t)
	dir := t.TempDir()

	outside := filepath.Join(t.TempDir(), "escaped.txt")
	result := runConfined(t, dir, "sh", "-c", "echo pwned > "+outside)

	if result.OK() {
		t.Fatal("a write outside the workspace must be denied")
	}
	if _, err := os.Stat(outside); err == nil {
		t.Fatal("the file was written despite confinement")
	}
}

// Writes alone are not enough. With only deny file-write*, an agent can still
// read every private key on the machine — verified on the Python side, and the
// reason a separate read-deny exists.
func TestCredentialDirectoriesAreUnreadable(t *testing.T) {
	requireMacOS(t)

	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("no home directory")
	}
	sshDir := filepath.Join(home, ".ssh")
	if _, err := os.Stat(sshDir); err != nil {
		t.Skip("no ~/.ssh to test against")
	}

	result := runConfined(t, t.TempDir(), "sh", "-c", "ls "+sshDir)
	if result.OK() {
		t.Fatal("~/.ssh must not be readable under confinement")
	}
}

// A profile that blocks git or node is useless: every real workflow shells out
// to them. Confinement that breaks the tools is confinement nobody keeps on.
func TestToolchainsStillWork(t *testing.T) {
	requireMacOS(t)
	dir := t.TempDir()

	for _, probe := range []struct {
		name string
		args []string
	}{
		{"git", []string{"git", "--version"}},
		{"sh", []string{"sh", "-c", "echo hello"}},
	} {
		t.Run(probe.name, func(t *testing.T) {
			if result := runConfined(t, dir, probe.args...); !result.OK() {
				t.Fatalf("%s must work under confinement: %s", probe.name, result.Stderr)
			}
		})
	}
}

// Absence is reported, never papered over. An unconfined run that claims to be
// confined is worse than one that admits it.
func TestMechanismIsReportedHonestly(t *testing.T) {
	info := Detect()
	if info.Mechanism == "" {
		t.Fatal("Detect must always name a mechanism, even if it is none")
	}
	if info.Mechanism == MechanismNone && info.Reason == "" {
		t.Fatal("an unavailable mechanism must explain why")
	}
	if runtime.GOOS == "darwin" {
		if _, err := os.Stat(sandboxExec); err == nil && info.Mechanism != MechanismSandboxExec {
			t.Fatalf("macOS with sandbox-exec present must report it, got %q", info.Mechanism)
		}
	}
}

func runConfined(t *testing.T, workspace string, argv ...string) exec.Result {
	t.Helper()
	wrapped, _, err := Wrap(argv, workspace)
	if err != nil {
		t.Fatalf("wrapping command: %v", err)
	}
	return exec.RunStreaming(context.Background(), exec.Command{
		Argv: wrapped, Dir: workspace, Timeout: 20_000_000_000,
	})
}
