package exec

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// Ported from specter_exec/allowlist.py --self-check. Every case here is a rule
// the Python implementation enforces in production today; a Go port that loses
// one of them is a regression, not a rewrite.

func writeAllowlist(t *testing.T, dir string, paths []string) string {
	t.Helper()
	p := filepath.Join(dir, "workspaces.json")
	body, err := json.Marshal(map[string][]string{"paths": paths})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, body, 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestApprovedWorkspace(t *testing.T) {
	root := t.TempDir()
	// EvalSymlinks: on macOS t.TempDir() hands back /var/... which is a symlink
	// to /private/var. Comparing an unresolved path against a resolved one fails
	// for reasons that have nothing to do with the rule under test.
	root, _ = filepath.EvalSymlinks(root)

	repo := filepath.Join(root, "repo")
	if err := os.MkdirAll(filepath.Join(repo, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "other"), 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := writeAllowlist(t, root, []string{repo})

	tests := []struct {
		name    string
		path    string
		allowed bool
	}{
		{"an approved root is allowed", repo, true},
		{"a subdirectory of it is allowed", filepath.Join(repo, "sub"), true},
		{"an unapproved sibling is rejected", filepath.Join(root, "other"), false},
		// Resolved before comparison, or ".." walks straight out of the root.
		{"traversal out of an approved root is rejected", filepath.Join(repo, "..", "other"), false},
		{"an empty path is rejected", "", false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, reason := ApprovedWorkspace(tc.path, cfg)
			if tc.allowed && got == "" {
				t.Fatalf("want allowed, got rejected: %s", reason)
			}
			if !tc.allowed && got != "" {
				t.Fatalf("want rejected, got allowed: %s", got)
			}
		})
	}
}

// FAIL CLOSED. A missing config means "not provisioned yet", never "allow
// everything" — that distinction is the whole point of the gate.
func TestMissingAllowlistFailsClosed(t *testing.T) {
	root := t.TempDir()
	got, reason := ApprovedWorkspace(root, filepath.Join(root, "does-not-exist.json"))
	if got != "" {
		t.Fatalf("a missing allowlist must reject, got %q", got)
	}
	if reason == "" {
		t.Fatal("rejection must explain what to do about it")
	}
}

// A corrupt file is also "not provisioned", not "allow everything".
func TestCorruptAllowlistFailsClosed(t *testing.T) {
	root := t.TempDir()
	bad := filepath.Join(root, "bad.json")
	if err := os.WriteFile(bad, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got, _ := ApprovedWorkspace(root, bad); got != "" {
		t.Fatalf("a corrupt allowlist must reject, got %q", got)
	}
}

// THE REGRESSION. Extracting this logic in Python kept only the runner's own
// token path, so the containerized backend read /root/.specter and silently
// ignored the mounted file beside it. The backend could no longer reach the
// runner at all, and nothing failed loudly.
func TestTokenResolutionOrder(t *testing.T) {
	root := t.TempDir()
	tok := filepath.Join(root, "runner-token")
	if err := os.WriteFile(tok, []byte("token-from-an-alternate-location\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	t.Setenv("SPECTER_RUNNER_TOKEN_FILE", tok)
	got := RunnerToken()
	if got != "token-from-an-alternate-location" {
		t.Fatalf("env override must win, got %q", got)
	}
}

func TestTokenMissingIsEmpty(t *testing.T) {
	t.Setenv("SPECTER_RUNNER_TOKEN_FILE", filepath.Join(t.TempDir(), "nope"))
	if got := RunnerToken(); got != "" {
		t.Fatalf("an absent token must be empty, got %q", got)
	}
}

// Minted 0600: it is the only thing between a local process and an agent
// running as this user.
func TestEnsureTokenMintsPrivate(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "runner-token")
	t.Setenv("SPECTER_RUNNER_TOKEN_FILE", path)

	token, err := EnsureRunnerToken()
	if err != nil {
		t.Fatal(err)
	}
	if len(token) < 32 {
		t.Fatalf("token too short to be a secret: %d chars", len(token))
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("token must be 0600, got %o", perm)
	}

	// Stable across calls, or every restart invalidates the backend's copy.
	again, err := EnsureRunnerToken()
	if err != nil {
		t.Fatal(err)
	}
	if again != token {
		t.Fatal("an existing token must be reused, not regenerated")
	}
}
