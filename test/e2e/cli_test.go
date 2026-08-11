// The CLI half of the binary.
//
// `specter serve` and `specter run` are the same artifact with different entry
// points — that is the premise of the rewrite — so the CLI needs its own
// coverage. Its failure modes are not the server's: argument parsing, exit
// codes, and what a human reads on a terminal.
package e2e

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// runCLI runs the binary against a state directory of its own.
//
// SPECTER_HOME relocates every state path at once — database, worktrees, runner
// token, approved workspaces — so a test never reads the developer's real
// ~/.specter. Without it these assertions depend on whichever workflows and
// approved repositories happen to be on the machine, which is how a suite
// passes locally and fails in CI.
//
// NO_COLOR because the assertions match plain text; escape codes would sit
// between the words being searched for.
func runCLI(t *testing.T, binary string, args ...string) (string, int) {
	t.Helper()
	return runCLIIn(t, binary, t.TempDir(), args...)
}

// runCLIIn is runCLI with the state directory supplied, for tests that need two
// invocations to share one.
func runCLIIn(t *testing.T, binary, home string, args ...string) (string, int) {
	t.Helper()
	cmd := exec.Command(binary, args...)
	cmd.Env = append(os.Environ(),
		"SPECTER_HOME="+home,
		"NO_COLOR=1",
		// Cleared explicitly: it outranks SPECTER_HOME, so a developer with it
		// set in their shell would point every test at one real database.
		"SDLC_DATABASE_PATH=",
	)
	out, err := cmd.CombinedOutput()
	code := 0
	if exitErr, ok := err.(*exec.ExitError); ok {
		code = exitErr.ExitCode()
	} else if err != nil {
		t.Fatalf("running %v: %v", args, err)
	}
	return string(out), code
}

func TestBareInvocationExplainsItself(t *testing.T) {
	// Someone who types `specter` with no arguments should learn what it does,
	// not read a stack trace.
	binary := buildBinary(t)
	out, _ := runCLI(t, binary)

	for _, want := range []string{"run", "serve"} {
		if !strings.Contains(out, want) {
			t.Errorf("the bare invocation does not mention %q:\n%s", want, out)
		}
	}
}

func TestAnUnknownCommandFailsLoudly(t *testing.T) {
	// Exit 0 on a typo means a script carries on as though the command ran.
	binary := buildBinary(t)
	out, code := runCLI(t, binary, "definitely-not-a-command")

	if code == 0 {
		t.Error("an unknown command exited 0 — a script would treat that as success")
	}
	if !strings.Contains(strings.ToLower(out), "unknown") {
		t.Errorf("the error does not say the command is unknown:\n%s", out)
	}
}

func TestHelpAndVersionExitZero(t *testing.T) {
	// Both are things a person asks for deliberately, so neither is an error.
	binary := buildBinary(t)
	for _, arg := range []string{"--help", "help", "--version", "version"} {
		if out, code := runCLI(t, binary, arg); code != 0 {
			t.Errorf("%q exited %d:\n%s", arg, code, out)
		}
	}
}

func TestRunWithoutAWorkflowExplainsWhatIsMissing(t *testing.T) {
	binary := buildBinary(t)
	out, code := runCLI(t, binary, "run")

	if code == 0 {
		t.Error("`specter run` with no workflow exited 0")
	}
	if strings.TrimSpace(out) == "" {
		t.Error("no message explaining what is missing")
	}
}

func TestFlagsAreAcceptedAfterAPositionalArgument(t *testing.T) {
	// Go's flag package STOPS at the first non-flag argument, so
	// `specter run wf --json` silently ignored every flag after `wf` —
	// including --repo, which changes what the run operates on. That is a
	// correctness bug, not a usability one.
	//
	// A nonexistent workflow fails either way; what is asserted is that the
	// flag was PARSED rather than treated as a positional.
	binary := buildBinary(t)
	out, _ := runCLI(t, binary, "run", "no-such-workflow", "--json",
		"--db", filepath.Join(t.TempDir(), "app.db"))

	if strings.Contains(out, "flag provided but not defined") {
		t.Errorf("a flag after a positional was not parsed:\n%s", out)
	}
}

func TestStatusDescribesTheMachine(t *testing.T) {
	// `specter status` answers "what can this machine do right now", which is
	// the first thing anyone runs when something is not working. It must work
	// before anything is installed or configured — no database, no server, no
	// container — so it is what a fresh `curl | sh` user runs first.
	binary := buildBinary(t)
	out, code := runCLI(t, binary, "status")

	if code != 0 {
		t.Errorf("status exited %d:\n%s", code, out)
	}
	// Each section answers a different "why is this not working" question.
	// Asserting the sections rather than "printed something" is the difference
	// between a test that catches a dropped section and one that does not.
	for _, section := range []string{"agents", "tools", "confinement", "state", "approved repositories"} {
		if !strings.Contains(out, section) {
			t.Errorf("status omits the %q section:\n%s", section, out)
		}
	}
}

// SPECTER_HOME moves five state paths at once. If status reported a path that
// did not follow it, the user would be told the wrong database — which is the
// confusion the state section exists to end.
func TestStatusReportsTheStateDirectoryItIsUsing(t *testing.T) {
	binary := buildBinary(t)
	home := t.TempDir()
	out, code := runCLIIn(t, binary, home, "status")

	if code != 0 {
		t.Fatalf("status exited %d:\n%s", code, out)
	}
	if !strings.Contains(out, home) {
		t.Errorf("status does not report the state directory %q it was given:\n%s", home, out)
	}
}

// The database is derived from the state directory, so `workflows` must read
// the same one status names. Two invocations, one home: the first creates the
// database, the second must find it rather than a second empty one.
func TestWorkflowsUsesTheSameDatabaseStatusReports(t *testing.T) {
	binary := buildBinary(t)
	home := t.TempDir()

	if _, code := runCLIIn(t, binary, home, "workflows"); code != 0 {
		t.Fatalf("workflows exited %d", code)
	}
	out, code := runCLIIn(t, binary, home, "status")
	if code != 0 {
		t.Fatalf("status exited %d:\n%s", code, out)
	}

	db := filepath.Join(home, "data", "app.db")
	if !strings.Contains(out, db) && !strings.Contains(out, home) {
		t.Errorf("status reports a database outside the state directory:\n%s", out)
	}
}

// The bug this replaced: defaultDBPath preferred ./data/app.db whenever that
// file existed, so the answer depended on the working directory. Any unrelated
// project containing a data/app.db silently adopted the CLI, and running from
// home created a second empty database while reporting "no workflows yet".
func TestTheWorkingDirectoryDoesNotChooseTheDatabase(t *testing.T) {
	binary := buildBinary(t)
	home := t.TempDir()

	// A decoy in the working directory, in the exact location the old rule
	// preferred.
	decoy := t.TempDir()
	if err := os.MkdirAll(filepath.Join(decoy, "data"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(decoy, "data", "app.db"), []byte("not a database"), 0o644); err != nil {
		t.Fatal(err)
	}

	cmd := exec.Command(binary, "status")
	cmd.Dir = decoy
	cmd.Env = append(os.Environ(), "SPECTER_HOME="+home, "NO_COLOR=1", "SDLC_DATABASE_PATH=")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("status failed in a directory holding a decoy database: %v\n%s", err, out)
	}
	if strings.Contains(string(out), decoy) {
		t.Errorf("the working directory's data/app.db was adopted:\n%s", out)
	}
}

// Skills and workflow templates are seeded insert-if-missing on startup. A
// fresh state directory that stayed empty would render an empty palette and an
// empty template gallery — indistinguishable from a broken install.
func TestServingAFreshStateDirectorySeedsTheBuiltIns(t *testing.T) {
	binary := buildBinary(t)
	home := t.TempDir()

	// `serve` seeds and then blocks, so it is started and stopped rather than
	// run to completion. Port 0 lets the OS choose, so a busy port on the
	// developer's machine cannot fail the test.
	cmd := exec.Command(binary, "serve", "--addr", "127.0.0.1:0")
	cmd.Env = append(os.Environ(), "SPECTER_HOME="+home, "NO_COLOR=1", "SDLC_DATABASE_PATH=")
	if err := cmd.Start(); err != nil {
		t.Fatalf("starting serve: %v", err)
	}
	defer func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}()

	db := filepath.Join(home, "data", "app.db")
	if !waitForFile(t, db) {
		t.Fatalf("serve did not create %s", db)
	}

	// Read through the CLI rather than opening the database, so this asserts
	// what a user would see. Templates are hidden from `workflows` by design,
	// so their absence here is not the assertion — the command succeeding
	// against a seeded database is.
	out, code := runCLIIn(t, binary, home, "workflows")
	if code != 0 {
		t.Errorf("workflows exited %d against a seeded database:\n%s", code, out)
	}
}

// Piped output is read by other programs and by log files. Escape codes between
// the words break both, and box-drawing characters arrive as mojibake on a
// terminal that cannot render them.
func TestPipedOutputCarriesNoEscapeCodes(t *testing.T) {
	binary := buildBinary(t)

	for _, args := range [][]string{{}, {"status"}, {"workflows"}} {
		out, _ := runCLI(t, binary, args...)
		if strings.Contains(out, "\033[") {
			t.Errorf("%v emitted escape codes when not attached to a terminal:\n%q", args, out)
		}
	}
}

// --repo changes which repository a run operates on. Go's flag package stops at
// the first positional, so before the reordering fix this was silently dropped
// and the run went somewhere else entirely. Asserting the VALUE reached the
// flag, not merely that parsing did not error.
func TestAFlagValueAfterAPositionalIsActuallyUsed(t *testing.T) {
	binary := buildBinary(t)
	repo := t.TempDir()

	out, code := runCLI(t, binary, "run", "no-such-workflow", "--repo", repo)
	if code == 0 {
		t.Error("running a nonexistent workflow exited 0")
	}
	if strings.Contains(out, "flag provided but not defined") {
		t.Errorf("the flag after a positional was not parsed:\n%s", out)
	}
	// The run is rejected either way; what matters is which repository the
	// rejection names. A dropped --repo would report the working directory.
	if cwd, err := os.Getwd(); err == nil && strings.Contains(out, cwd) {
		t.Errorf("--repo was ignored and the working directory was used instead:\n%s", out)
	}
}

// An unapproved workspace must be refused before any agent is spawned. This is
// the allowlist's whole purpose, and a CLI that ran first and checked later
// would have already handed an agent a repository nobody approved.
func TestRunRefusesAnUnapprovedWorkspace(t *testing.T) {
	binary := buildBinary(t)
	out, code := runCLI(t, binary, "run", "any-workflow", "--repo", t.TempDir())

	if code == 0 {
		t.Errorf("a run against an unapproved workspace exited 0:\n%s", out)
	}
	if strings.TrimSpace(out) == "" {
		t.Error("the refusal explained nothing")
	}
}

func waitForFile(t *testing.T, path string) bool {
	t.Helper()
	for i := 0; i < 100; i++ {
		if _, err := os.Stat(path); err == nil {
			return true
		}
		time.Sleep(50 * time.Millisecond)
	}
	return false
}
