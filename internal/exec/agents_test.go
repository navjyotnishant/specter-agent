package exec

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// Ported from specter_exec/agents.py --self-check.
//
// This is not exec.LookPath with extra steps. Under launchd the runner inherits
// PATH=/usr/bin:/bin:/usr/sbin:/sbin — none of the places a developer's CLIs
// live — so LookPath alone reports every Homebrew and npm agent as "not
// installed" while it sits in /opt/homebrew/bin.

func TestResolveCLI(t *testing.T) {
	root := t.TempDir()

	executable := filepath.Join(root, "faux-agent")
	if err := os.WriteFile(executable, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	notExecutable := filepath.Join(root, "not-executable")
	if err := os.WriteFile(notExecutable, []byte("data"), 0o644); err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name  string
		names []string
		want  string
	}{
		// THE LAUNCHD CASE: not on PATH, but present in a known root.
		{"finds an executable in a known root", []string{"faux-agent"}, executable},
		{"returns empty for something absent", []string{"no-such-agent-anywhere"}, ""},
		// A readable-but-not-executable file is not a CLI. Returning it would
		// surface as "permission denied" at spawn time instead of a clear
		// "not installed".
		{"ignores a non-executable file", []string{"not-executable"}, ""},
		// Several names for one tool — cursor-agent and cursor.
		{"tries each name in order", []string{"missing", "faux-agent"}, executable},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := ResolveCLI(tc.names, []string{root}); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

// PATH must win, so a developer's own build overrides an installed one.
func TestPathIsPreferredOverRoots(t *testing.T) {
	want, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("sh not on PATH")
	}
	if got := ResolveCLI([]string{"sh"}, []string{"/nonexistent"}); got != want {
		t.Fatalf("PATH must win: got %q, want %q", got, want)
	}
}
