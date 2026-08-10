// Package hostops implements the host-machine operations the Python host runner
// used to provide over HTTP.
//
// Native Go already spawns agents directly, so there is no runner process to ask
// — these operations run in the same binary. That removes the last Python from
// the stack, and with it a whole class of failure: a backend that works only
// while a second process happens to be alive.
package hostops

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	execpkg "github.com/navjyotnishant/specter-agent/internal/exec"
)

// Probing spawns real binaries, so the defaults are conservative: the Models
// page POLLS this, and a settings tab left open must not spawn agents forever.
const (
	defaultProbeTimeout = 10 * time.Second
	defaultCacheTTL     = 60 * time.Second
)

type AgentStatus struct {
	Key            string `json:"key"`
	DisplayName    string `json:"display_name"`
	Installed      bool   `json:"installed"`
	Authenticated  bool   `json:"authenticated"`
	Version        string `json:"version"`
	ExecutablePath string `json:"executable_path"`
	AuthNote       string `json:"auth_note"`
	DocsURL        string `json:"docs_url"`
}

type RuntimeStatus struct {
	RuntimeID   string        `json:"runtime_id"`
	DisplayName string        `json:"display_name"`
	Status      string        `json:"status"`
	Available   bool          `json:"available"`
	Installed   bool          `json:"installed"`
	AgentStatus []AgentStatus `json:"agent_status"`
	RunnerMode  string        `json:"runner_mode"`
	Message     string        `json:"message"`
}

// Prober inspects the host. Roots and HomeDir are injectable so tests can point
// it at a scratch directory instead of the developer's real machine.
type Prober struct {
	// Roots limits where binaries are looked for. When set, PATH is NOT
	// searched — a caller that pins the roots wants exactly one filesystem, not
	// this machine's agents leaking in. Empty means the normal PATH-first
	// resolution.
	Roots        []string
	HomeDir      string
	ProbeTimeout time.Duration
	CacheTTL     time.Duration

	mu       sync.Mutex
	cached   *RuntimeStatus
	cachedAt time.Time
}

type agentSpec struct {
	key, displayName, docsURL string
	binaries                  []string
	// authProbe reports whether the agent is signed in. Nil means "installed is
	// enough" — used where there is nothing cheap to check.
	authProbe func(p *Prober, exe string) (bool, string)
	authHint  string
}

// The order here is the order the UI lists them in.
var agentSpecs = []agentSpec{
	{
		key: "claude", displayName: "Claude Code", binaries: []string{"claude"},
		docsURL:  "https://docs.claude.com/en/docs/claude-code",
		authHint: "Not logged in — run: claude /login",
		authProbe: func(p *Prober, exe string) (bool, string) {
			// No credential file to read, so the binary is asked. This is why
			// the whole status is cached.
			out := p.runCapture(exe, "--dangerously-skip-permissions", "-p", "ping")
			if refusesAuth(out) {
				return false, "Not logged in — run: claude /login"
			}
			return true, "Logged in"
		},
	},
	{
		key: "codex", displayName: "Codex CLI", binaries: []string{"codex"},
		docsURL:  "https://developers.openai.com/codex/cli",
		authHint: "Run `codex login` to sign in.",
	},
	{
		key: "cursor", displayName: "Cursor", binaries: []string{"cursor-agent", "cursor"},
		docsURL:  "https://docs.cursor.com/en/cli/overview",
		authHint: "Not logged in — open Cursor and sign in",
		authProbe: func(p *Prober, exe string) (bool, string) {
			out := p.runCapture(exe, "--trust", "--print", "ping")
			if refusesAuth(out) {
				return false, "Not logged in — open Cursor and sign in"
			}
			return true, "Logged in"
		},
	},
	{
		key: "gemini", displayName: "Gemini", binaries: []string{"gemini"},
		docsURL:  "https://github.com/google-gemini/gemini-cli",
		authHint: "Run `gemini` once and sign in with your Google account.",
		authProbe: func(p *Prober, exe string) (bool, string) {
			// Read the credential file rather than invoking the CLI: a real
			// prompt costs a QUOTA CALL, and this endpoint is polled.
			path := filepath.Join(p.home(), ".gemini", "google_accounts.json")
			body, err := os.ReadFile(path)
			if err != nil {
				return false, "Run `gemini` once and sign in with your Google account."
			}
			var accounts map[string]any
			if json.Unmarshal(body, &accounts) != nil || len(accounts) == 0 {
				// Present but empty: the file existing is not being signed in.
				return false, "Run `gemini` once and sign in with your Google account."
			}
			return true, ""
		},
	},
}

func (p *Prober) resolve(binaries []string) string {
	if len(p.Roots) > 0 {
		return execpkg.ResolveCLIIn(binaries, p.Roots)
	}
	return execpkg.ResolveCLI(binaries, nil)
}

func (p *Prober) home() string {
	if p.HomeDir != "" {
		return p.HomeDir
	}
	home, _ := os.UserHomeDir()
	return home
}

func (p *Prober) timeout() time.Duration {
	if p.ProbeTimeout > 0 {
		return p.ProbeTimeout
	}
	return defaultProbeTimeout
}

// runCapture runs a probe and returns its output. Errors are folded in rather
// than raised: what matters is what the binary SAID, and a non-zero exit from an
// unauthenticated agent is expected.
//
// Goes through internal/exec rather than CombinedOutput(). CombinedOutput waits
// for the output pipe to CLOSE, and a killed process whose grandchild inherited
// that pipe keeps it open — so the context deadline fires, the child dies, and
// the call blocks anyway. internal/exec drains both pipes concurrently and
// returns when the process does, which is the whole reason it exists.
func (p *Prober) runCapture(argv ...string) string {
	result := execpkg.RunStreaming(context.Background(), execpkg.Command{
		Argv:    argv,
		Dir:     p.home(),
		Timeout: p.timeout(),
	})
	return result.Stdout + result.Stderr
}

// refusesAuth reads a refusal out of an agent's own words. Matching on prose is
// fragile, so a NEW phrasing reads as signed-in rather than signed-out — the
// failure that shows a working agent as broken is worse than the reverse, which
// surfaces at the next run with a real message.
func refusesAuth(output string) bool {
	lowered := strings.ToLower(output)
	for _, phrase := range []string{
		"not logged in", "login required", "authenticate",
		"authentication required", "sign in",
	} {
		if strings.Contains(lowered, phrase) {
			return true
		}
	}
	return false
}

// AgentStatus probes every known agent. Probes run CONCURRENTLY: four agents
// probed in sequence, each with a ten-second ceiling, is a forty-second page
// load in the worst case.
func (p *Prober) AgentStatus() []AgentStatus {
	statuses := make([]AgentStatus, len(agentSpecs))
	var wg sync.WaitGroup
	for i, spec := range agentSpecs {
		wg.Add(1)
		go func(i int, spec agentSpec) {
			defer wg.Done()
			statuses[i] = p.probeAgent(spec)
		}(i, spec)
	}
	wg.Wait()
	return statuses
}

func (p *Prober) probeAgent(spec agentSpec) AgentStatus {
	status := AgentStatus{
		Key: spec.key, DisplayName: spec.displayName, DocsURL: spec.docsURL,
	}

	exe := p.resolve(spec.binaries)
	if exe == "" {
		// Not installed is not authenticated: a green tick beside an agent that
		// cannot run is worse than no tick.
		status.AuthNote = spec.binaries[0] + " not found on PATH. " + spec.authHint
		return status
	}
	status.Installed = true
	status.ExecutablePath = exe

	if version := firstLine(p.runCapture(exe, "--version")); version != "" {
		status.Version = version
	}

	if spec.authProbe == nil {
		// Nothing cheap to check. Installed is as much as can be claimed.
		status.Authenticated = true
		status.AuthNote = ""
		return status
	}
	status.Authenticated, status.AuthNote = spec.authProbe(p, exe)
	return status
}

func firstLine(s string) string {
	for _, line := range strings.Split(s, "\n") {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

// DirectCLIStatus summarises the runtime, cached.
//
// Without the cache an open settings page spawns two agents every few seconds,
// indefinitely.
func (p *Prober) DirectCLIStatus() RuntimeStatus {
	ttl := p.CacheTTL
	if ttl == 0 {
		ttl = defaultCacheTTL
	}

	p.mu.Lock()
	if p.cached != nil && time.Since(p.cachedAt) < ttl {
		cached := *p.cached
		p.mu.Unlock()
		return cached
	}
	p.mu.Unlock()

	agents := p.AgentStatus()
	anyReady, allMissing := false, true
	for _, a := range agents {
		if a.Installed && a.Authenticated {
			anyReady = true
		}
		if a.Installed {
			allMissing = false
		}
	}

	status := RuntimeStatus{
		RuntimeID: "direct-cli", DisplayName: "Direct CLI Runtime",
		AgentStatus: agents, Available: anyReady, Installed: !allMissing,
		RunnerMode: "safe",
	}
	switch {
	case anyReady:
		status.Status = "ready"
		status.Message = "Direct CLI is ready. Agents run directly on your host machine without sandbox isolation."
	case allMissing:
		// Distinct from setup_required: nothing installed is a different
		// problem from something installed but not signed in.
		status.Status = "missing"
		status.Message = "No Direct CLI agents are installed. Install at least one agent to use Direct CLI."
	default:
		status.Status = "setup_required"
		status.Message = "An agent is installed but not signed in. Sign in to use Direct CLI."
	}

	p.mu.Lock()
	p.cached, p.cachedAt = &status, time.Now()
	p.mu.Unlock()
	return status
}
