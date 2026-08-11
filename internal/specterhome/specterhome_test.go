package specterhome

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDefaultsToDotSpecterUnderHome(t *testing.T) {
	t.Setenv(Env, "")

	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("no home directory")
	}
	if got, want := Dir(), filepath.Join(home, ".specter"); got != want {
		t.Errorf("Dir() = %q, want %q", got, want)
	}
}

func TestOverrideRelocatesEverything(t *testing.T) {
	root := t.TempDir()
	t.Setenv(Env, root)

	if got := Dir(); got != root {
		t.Errorf("Dir() = %q, want %q", got, root)
	}
	if got, want := Path("data", "app.db"), filepath.Join(root, "data", "app.db"); got != want {
		t.Errorf("Path() = %q, want %q", got, want)
	}
}

// The bug this package exists to prevent: SPECTER_HOME was honoured by the
// database path alone, so overriding it moved the database and left the run
// worktrees, the runner token and the approved-workspace list behind. A state
// directory split across two locations is worse than one in the wrong place —
// the run history says a workflow never ran while its worktree sits elsewhere.
//
// Every state path must sit under one root. This asserts the shape rather than
// importing the five callers, which would be an import cycle.
func TestEveryStatePathSharesOneRoot(t *testing.T) {
	root := t.TempDir()
	t.Setenv(Env, root)

	for _, rel := range [][]string{
		{"data", "app.db"},  // the database, read by the CLI and the server
		{"runs"},            // run worktrees
		{"runner-token"},    // who may drive execution
		{"workspaces.json"}, // which repositories are approved
		{"sbx-daemon.log"},  // the sandbox daemon log
	} {
		got := Path(rel...)
		if !strings.HasPrefix(got, root+string(filepath.Separator)) {
			t.Errorf("%v resolved to %q, outside the state root %q", rel, got, root)
		}
	}
}

// An empty value is not a choice. Treating it as one would resolve the state
// directory to the filesystem root — compose has the same hazard, which is why
// its default fires on unset rather than empty.
func TestEmptyOverrideFallsBackToHome(t *testing.T) {
	t.Setenv(Env, "")

	if got := Dir(); got == "" || got == string(filepath.Separator) {
		t.Errorf("an empty %s resolved to %q", Env, got)
	}
}
