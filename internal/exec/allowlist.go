// Package exec is Specter's execution engine: everything needed to run an agent
// on this machine, with nothing about how the request arrived.
//
// The CLI imports it directly. So does the server. That is the whole design —
// one implementation, two entry points, no HTTP between a caller and a
// subprocess it is about to spawn on the same machine.
package exec

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/navjyotnishant/specter-agent/internal/specterhome"
)

// Who may drive execution, and where it may run.
//
// Both gates live here rather than in the caller, because this is the layer that
// spawns a process as the host user. A caller that could be trusted to check
// would not need the check.

const (
	// AuthHeader carries the shared secret when execution is driven over HTTP.
	// Binding to localhost is not an authorization boundary: every local process
	// shares that address.
	AuthHeader = "X-Specter-Runner-Token"

	tokenEnv     = "SPECTER_RUNNER_TOKEN_FILE"
	allowlistEnv = "SPECTER_WORKSPACES_CONFIG"
)

// tokenCandidates is ordered, because the backend runs in two places and only
// one of them can see the host's home directory.
//
//  1. the explicit override
//  2. the mount a containerized backend can read
//  3. the native default, where the runner writes when nothing overrides it
//
// Losing step 2 during a refactor silently broke the containerized backend once
// already: it read /root/.specter and ignored the mounted file beside it.
func tokenCandidates() []string {
	// An explicit override is AUTHORITATIVE, not a first preference. Falling
	// through to a different token when the named file is missing is worse than
	// finding none: it silently uses a credential the operator did not point at,
	// and a test or a container would appear to work while reading the wrong
	// secret.
	if override := os.Getenv(tokenEnv); override != "" {
		return []string{override}
	}

	return []string{"/app/secrets/runner-token", specterhome.Path("runner-token")}
}

// RunnerToken returns the shared secret, or "" when unprovisioned.
func RunnerToken() string {
	for _, candidate := range tokenCandidates() {
		body, err := os.ReadFile(candidate)
		if err != nil {
			continue
		}
		if token := strings.TrimSpace(string(body)); token != "" {
			return token
		}
	}
	return ""
}

// EnsureRunnerToken reads the token, minting one on first use.
//
// Written 0600 and reused thereafter: regenerating on every start would
// invalidate whatever copy the backend already holds.
func EnsureRunnerToken() (string, error) {
	if existing := RunnerToken(); existing != "" {
		return existing, nil
	}

	path := tokenCandidates()[0]
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", fmt.Errorf("creating token directory: %w", err)
	}

	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("generating token: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(buf)

	if err := os.WriteFile(path, []byte(token), 0o600); err != nil {
		return "", fmt.Errorf("writing token: %w", err)
	}
	return token, nil
}

// AllowlistPath is where the approved-workspace list lives. Overridable for the
// same reason as the token: a containerized backend cannot see the host's home.
func AllowlistPath() string {
	if override := os.Getenv(allowlistEnv); override != "" {
		return override
	}
	return specterhome.Path("workspaces.json")
}

// approvedRoots reads the synced allowlist.
//
// A nil slice with no error is impossible here on purpose: the caller must be
// able to tell "no roots approved" from "the file is missing", because those
// demand opposite answers. Missing returns an error; empty returns an empty
// slice.
func approvedRoots(configPath string) ([]string, error) {
	body, err := os.ReadFile(configPath)
	if err != nil {
		return nil, fmt.Errorf("reading allowlist: %w", err)
	}

	var wrapper struct {
		Paths []string `json:"paths"`
	}
	if err := json.Unmarshal(body, &wrapper); err != nil {
		return nil, fmt.Errorf("parsing allowlist: %w", err)
	}

	out := make([]string, 0, len(wrapper.Paths))
	for _, raw := range wrapper.Paths {
		if strings.TrimSpace(raw) == "" {
			continue
		}
		resolved, err := filepath.EvalSymlinks(raw)
		if err != nil {
			// An approved path that no longer exists is not an error worth
			// failing the whole list over; it simply matches nothing.
			resolved = filepath.Clean(raw)
		}
		out = append(out, resolved)
	}
	return out, nil
}

// ApprovedWorkspace resolves a requested workspace against the allowlist.
//
// Returns the resolved path and "" when approved, or "" and a reason when not.
//
// Paths are resolved BEFORE comparison. Without that, "approved/../elsewhere"
// walks straight out of an approved root, and a symlink inside one points
// anywhere on the filesystem.
func ApprovedWorkspace(path, configPath string) (string, string) {
	if strings.TrimSpace(path) == "" {
		return "", "Workspace path is required."
	}

	requested, err := filepath.EvalSymlinks(path)
	if err != nil {
		requested = filepath.Clean(path)
	}
	requested, _ = filepath.Abs(requested)

	roots, err := approvedRoots(configPath)
	if err != nil {
		// FAIL CLOSED. Not provisioned is not permission.
		return "", fmt.Sprintf(
			"This runner has no approved-workspace list yet. Start the Specter "+
				"backend once to sync it, or write %s yourself.", configPath)
	}
	if len(roots) == 0 {
		return "", "No repositories are approved for agent execution."
	}

	for _, root := range roots {
		if requested == root || strings.HasPrefix(requested, root+string(filepath.Separator)) {
			return requested, ""
		}
	}
	return "", fmt.Sprintf("Workspace path is not approved for agent execution: %s", requested)
}
