// The CLI half of the binary.
//
// `specter serve` and `specter run` are the same artifact with different entry
// points — that is the premise of the rewrite — so the CLI needs its own
// coverage. Its failure modes are not the server's: argument parsing, exit
// codes, and what a human reads on a terminal.
package e2e

import (
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func runCLI(t *testing.T, binary string, args ...string) (string, int) {
	t.Helper()
	cmd := exec.Command(binary, args...)
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
	// the first thing anyone runs when something is not working.
	binary := buildBinary(t)
	out, code := runCLI(t, binary, "status")

	if code != 0 {
		t.Errorf("status exited %d:\n%s", code, out)
	}
	if strings.TrimSpace(out) == "" {
		t.Error("status printed nothing")
	}
}
