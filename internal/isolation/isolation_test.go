package isolation

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

// The generated profile must come FROM the policy. Two copies of a security
// rule drift, and the copy nobody edits is the one still being enforced — so
// this asserts the profile contains what the policy declares, rather than
// re-listing the paths and creating a third copy.
func TestTheProfileIsBuiltFromThePolicy(t *testing.T) {
	requireMacOS(t)
	workspace := t.TempDir()

	profile, err := macOSProfile(workspace)
	if err != nil {
		t.Fatal(err)
	}
	policy := DefaultPolicy(workspace)

	for _, path := range policy.WritablePaths {
		if !strings.Contains(profile, path) {
			t.Errorf("policy allows writing %s, but the profile never mentions it", path)
		}
	}
	for _, path := range policy.UnreadablePaths {
		if !strings.Contains(profile, `(deny file-read* (subpath "`+path+`"))`) {
			t.Errorf("policy denies reading %s, but the profile does not", path)
		}
	}
}

// The network is NOT bounded today, and the code must say so rather than let a
// caller assume the whole machine is contained. sandbox-exec can express network
// rules but they are undocumented and deprecated; a boundary built on guesswork
// is worse than an absent one that is declared.
func TestNetworkIsHonestlyReportedAsUnrestricted(t *testing.T) {
	if DefaultPolicy(t.TempDir()).NetworkRestricted() {
		t.Error("the default policy claims to restrict the network, and nothing implements that")
	}
}

// The Warden must report layers that do NOT hold, not just the ones that do.
// Reporting only good news is how "sandbox-exec ✓" came to sit above an
// execution path that applied no confinement at all.
func TestWardenReportsTheGapsNotJustTheBoundaries(t *testing.T) {
	w := Warden()

	byName := map[string]Layer{}
	for _, layer := range w.Layers {
		byName[layer.Name] = layer
	}

	for _, name := range []string{"filesystem", "credentials", "reads", "network"} {
		if _, ok := byName[name]; !ok {
			t.Errorf("the warden does not report the %q layer at all", name)
		}
	}

	// The network is not bounded today. Claiming it would be the most
	// consequential lie the report could tell, so it is asserted rather than
	// left to a reader's assumption. (Reads WERE in this list until the profile
	// became deny-first within $HOME.)
	for _, name := range []string{"network"} {
		layer := byName[name]
		if layer.Held {
			t.Errorf("the warden claims the %q layer holds, and nothing implements it", name)
		}
		if layer.Gap == "" {
			t.Errorf("the %q layer does not hold but names no consequence", name)
		}
	}
}

// A layer that does not hold must say what is exposed. "reads: open" tells a
// reader nothing they can act on.
func TestEveryUnheldLayerNamesWhatIsExposed(t *testing.T) {
	for _, layer := range Warden().Layers {
		if !layer.Held && layer.Gap == "" {
			t.Errorf("layer %q is not held and explains no consequence", layer.Name)
		}
		if layer.Detail == "" {
			t.Errorf("layer %q has no detail", layer.Name)
		}
	}
}

// Reads outside the worktree are denied, not just credential paths.
//
// Before this, the profile was (allow default) with four denials — so a
// "confined" agent could read every other repository on the machine and the
// whole of ~/Desktop. The denial is now broad within $HOME, with toolchain
// paths re-allowed explicitly.
func TestReadsOutsideTheWorktreeAreDenied(t *testing.T) {
	requireMacOS(t)
	workspace := t.TempDir()
	home, _ := os.UserHomeDir()

	// A directory in $HOME that is nobody's toolchain and nobody's worktree.
	victim := filepath.Join(home, ".specter-read-probe")
	if err := os.MkdirAll(victim, 0o755); err != nil {
		t.Skip("cannot create a probe directory in $HOME")
	}
	t.Cleanup(func() { os.RemoveAll(victim) })
	secret := filepath.Join(victim, "notes.txt")
	os.WriteFile(secret, []byte("private"), 0o600)

	argv, _, err := Wrap([]string{"/bin/cat", secret}, workspace)
	if err != nil {
		t.Fatal(err)
	}
	result := exec.RunStreaming(context.Background(), exec.Command{Argv: argv, Dir: workspace})
	if result.OK() {
		t.Error("a confined agent read a file in $HOME outside its worktree")
	}
}

// ...but the toolchain still works, which is the constraint that makes the
// policy adoptable. A read policy that breaks `git status` gets switched off.
func TestToolchainPathsStayReadable(t *testing.T) {
	requireMacOS(t)
	workspace := t.TempDir()
	home, _ := os.UserHomeDir()

	config := filepath.Join(home, ".config")
	if _, err := os.Stat(config); err != nil {
		t.Skip("no ~/.config on this machine")
	}

	argv, _, err := Wrap([]string{"/bin/ls", config}, workspace)
	if err != nil {
		t.Fatal(err)
	}
	if result := exec.RunStreaming(context.Background(), exec.Command{Argv: argv, Dir: workspace}); !result.OK() {
		t.Error("~/.config is unreadable, which breaks tools and gets confinement disabled")
	}
}
