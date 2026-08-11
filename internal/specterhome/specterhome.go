// Package specterhome resolves where Specter keeps its state.
//
// Author: Navjyot Nishant
// Created: 2026-08-10
// Last updated: 2026-08-10
// Description: single resolver for the state directory, honouring SPECTER_HOME.
//
// WHY THIS IS ONE FUNCTION AND NOT A CONSTANT PER CALLER
// The state directory is read from five places — the database, run worktrees,
// the runner token, the approved-workspace list, and the sandbox daemon log.
// When each one built its own path, SPECTER_HOME was honoured by exactly one of
// them, so overriding it moved the database and left everything else behind. A
// split state directory is worse than a wrong one: the run history says a
// workflow never ran while its worktree sits somewhere else on disk.
//
// docker-compose reads the same variable, so the container and the CLI resolve
// to one directory rather than two.
package specterhome

import (
	"os"
	"path/filepath"
)

// Env relocates the whole state directory.
const Env = "SPECTER_HOME"

// Dir is the state directory: $SPECTER_HOME, else ~/.specter.
//
// Falls back to a temp directory when there is no home — a daemon running as a
// user without one should still work rather than writing to the filesystem root.
func Dir() string {
	if root := os.Getenv(Env); root != "" {
		return root
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join(os.TempDir(), "specter")
	}
	return filepath.Join(home, ".specter")
}

// Path joins elements onto the state directory.
func Path(elem ...string) string {
	return filepath.Join(append([]string{Dir()}, elem...)...)
}
