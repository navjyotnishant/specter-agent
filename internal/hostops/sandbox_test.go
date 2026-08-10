// Docker Sandbox (`sbx`) — status, daemon lifecycle, and network policy.
//
// Two things here are not obvious and both come from Python's own comments,
// which record bugs they hit:
//
//  1. `sbx daemon start` runs in the FOREGROUND. It does not fork. Waiting on it
//     blocks until the timeout and then KILLS the daemon that was just started —
//     which is why starting it from the app appeared to never work. It has to be
//     detached and then polled for readiness.
//
//  2. The current policy is INFERRED from `sbx policy ls` output, because there
//     is no command that reports it directly. Inference means an unrecognised
//     output must read as "custom", never as a specific policy — telling someone
//     their network is denied when it is open is worse than admitting ignorance.
package hostops

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSandboxIsMissingWhenTheCLIIsAbsent(t *testing.T) {
	sb := &Sandbox{Roots: []string{t.TempDir()}, HomeDir: t.TempDir()}
	status := sb.Status()

	if status.Installed {
		t.Error("reported installed with no sbx binary")
	}
	if status.Available {
		t.Error("reported available while not installed")
	}
	if status.Status != "missing" {
		t.Errorf("status = %q, want missing", status.Status)
	}
	if status.Message == "" {
		t.Error("no message telling the user what to install")
	}
}

func TestPolicyIsInferredFromTheRuleList(t *testing.T) {
	cases := []struct {
		name, output, want string
	}{
		{"balanced", "default-ai-services\ndefault-package-managers\n", "balanced"},
		{"allow all", "default-allow-all\n", "allow-all"},
		{"deny all", "No policy rules\n", "deny-all"},
		{"empty is deny", "", "deny-all"},
		// Anything unrecognised is CUSTOM. Claiming a specific policy from
		// output nobody anticipated tells the user their network is in a state
		// it may not be in.
		{"unrecognised is custom", "some-rule-we-have-never-seen\n", "custom"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			writeExecutable(t, dir, "sbx", "cat <<'OUT'\n"+c.output+"OUT")
			sb := &Sandbox{Roots: []string{dir}, HomeDir: t.TempDir()}

			policy := sb.PolicyStatus()
			if policy.CurrentPolicy != c.want {
				t.Errorf("policy = %q, want %q (from output %q)", policy.CurrentPolicy, c.want, c.output)
			}
		})
	}
}

func TestPolicyStatusReportsUnavailableWhenTheCommandFails(t *testing.T) {
	// Distinct from a policy value: the difference between "your network is
	// open" and "I could not find out" matters to whoever is reading it.
	dir := t.TempDir()
	writeExecutable(t, dir, "sbx", `echo "cannot connect to daemon" >&2; exit 1`)
	sb := &Sandbox{Roots: []string{dir}, HomeDir: t.TempDir()}

	policy := sb.PolicyStatus()
	if policy.OK {
		t.Error("a failed command reported ok")
	}
	if policy.CurrentPolicy != "" {
		t.Errorf("current_policy = %q — a failed query must not claim a policy", policy.CurrentPolicy)
	}
	if policy.Status != "unavailable" {
		t.Errorf("status = %q, want unavailable", policy.Status)
	}
	if !strings.Contains(policy.Diagnostic, "cannot connect") {
		t.Error("the command's own error was not surfaced")
	}
}

func TestOnlyKnownPoliciesAreAccepted(t *testing.T) {
	// A typo must not silently apply nothing, and must not be passed through to
	// the CLI where it might mean something else.
	dir := t.TempDir()
	writeExecutable(t, dir, "sbx", `exit 0`)
	sb := &Sandbox{Roots: []string{dir}, HomeDir: t.TempDir()}

	for _, bad := range []string{"", "allow_all", "ALLOW-ALL ", "wide-open"} {
		result := sb.SetPolicy(bad)
		if result.OK {
			t.Errorf("policy %q was accepted", bad)
		}
	}
	for _, good := range []string{"allow-all", "balanced", "deny-all"} {
		if result := sb.SetPolicy(good); !result.OK {
			t.Errorf("policy %q was rejected: %s", good, result.Message)
		}
	}
}

func TestDaemonStartDoesNotWaitOnAForegroundProcess(t *testing.T) {
	// THE BUG PYTHON RECORDED. `sbx daemon start` does not fork, so waiting on
	// it blocks until the timeout and then kills the daemon it just started.
	//
	// This fake never exits, exactly like the real one. If the implementation
	// waits, this test hangs.
	dir := t.TempDir()
	home := t.TempDir()
	writeExecutable(t, dir, "sbx", `
if [ "$2" = "status" ]; then
  # Not running until the marker exists.
  [ -f `+filepath.Join(home, "started")+` ] && { echo "daemon is running"; exit 0; }
  exit 1
fi
# `+"`daemon start`"+` runs forever in the foreground, like the real CLI.
touch `+filepath.Join(home, "started")+`
sleep 300
`)

	sb := &Sandbox{Roots: []string{dir}, HomeDir: home, DaemonWait: 5 * time.Second}
	done := make(chan DaemonResult, 1)
	go func() { done <- sb.StartDaemon() }()

	select {
	case result := <-done:
		if !result.OK {
			t.Errorf("the daemon did not come up: %s", result.Message)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("StartDaemon waited on a foreground process — the real CLI never returns, " +
			"so this would block and then kill the daemon it started")
	}
}

func TestStartingAnAlreadyRunningDaemonIsANoOp(t *testing.T) {
	dir := t.TempDir()
	home := t.TempDir()
	counter := filepath.Join(home, "starts")
	writeExecutable(t, dir, "sbx", `
if [ "$2" = "status" ]; then echo "daemon is running"; exit 0; fi
echo x >> `+counter+`
sleep 300
`)

	sb := &Sandbox{Roots: []string{dir}, HomeDir: home, DaemonWait: 3 * time.Second}
	result := sb.StartDaemon()
	if !result.OK {
		t.Fatalf("reported failure for a running daemon: %s", result.Message)
	}
	if _, err := os.Stat(counter); err == nil {
		t.Error("a second daemon was launched while one was already running")
	}
}

func TestDaemonStartReportsFailureWhenItNeverComesUp(t *testing.T) {
	// Rather than hanging, and rather than claiming success.
	dir := t.TempDir()
	writeExecutable(t, dir, "sbx", `
if [ "$2" = "status" ]; then exit 1; fi
sleep 300
`)
	sb := &Sandbox{Roots: []string{dir}, HomeDir: t.TempDir(), DaemonWait: 1 * time.Second}

	start := time.Now()
	result := sb.StartDaemon()
	if result.OK {
		t.Error("reported success for a daemon that never became ready")
	}
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Errorf("waited %s before giving up", elapsed)
	}
	if result.Message == "" {
		t.Error("no explanation of what failed")
	}
}

func TestStartingWithNoCLIInstalledFailsCleanly(t *testing.T) {
	sb := &Sandbox{Roots: []string{t.TempDir()}, HomeDir: t.TempDir()}
	result := sb.StartDaemon()
	if result.OK {
		t.Error("reported success with no sbx installed")
	}
	if !strings.Contains(strings.ToLower(result.Message), "not installed") {
		t.Errorf("message = %q, want it to say the CLI is missing", result.Message)
	}
}

// `sbx version`, not `sbx --version`. The flag does not exist and the CLI
// answers "ERROR: unknown flag: --version", which a naive first-line read
// reports as the version — found by running it against the real binary.
func TestVersionUsesTheSubcommandNotAFlag(t *testing.T) {
	dir := t.TempDir()
	writeExecutable(t, dir, "sbx", `
case "$1" in
  version) echo "sbx version: v0.34.0" ;;
  --version) echo "ERROR: unknown flag: --version" >&2; exit 1 ;;
  daemon) echo "daemon is running" ;;
esac`)

	sb := &Sandbox{Roots: []string{dir}, HomeDir: t.TempDir()}
	status := sb.Status()

	if strings.Contains(status.Version, "unknown flag") {
		t.Errorf("an error message was reported as a version: %q", status.Version)
	}
	if !strings.Contains(status.Version, "v0.34.0") {
		t.Errorf("version = %q, want the real version", status.Version)
	}
}
