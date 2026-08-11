// Package agenthost spawns agents on behalf of a backend that cannot.
//
// Author: Navjyot Nishant
// Created: 2026-08-11
// Last updated: 2026-08-11
// Description: host-side agent spawner for containerized deployments.
//
// WHY THIS EXISTS AGAIN
// A container has no agent binary and no credentials, so a containerized backend
// cannot run an agent — `which claude` inside it returns nothing and ~/.claude
// does not exist. Python solved this with a separate host runner; the Go port
// removed it on the reasoning that the server could simply run on the host
// instead. That is true, and it is not always acceptable: wanting the app
// contained, with the host's filesystem and credentials out of its reach, is a
// legitimate boundary. This restores the bridge without restoring the second
// program — `specter agent-host` is a subcommand of the same binary, so there is
// nothing extra to install and no version skew between the two halves.
//
// WHAT MAKES IT SAFE TO EXPOSE
// It spawns processes on request, so it is a privileged surface and treated as
// one: bound to loopback, authenticated with the shared runner token, and every
// workspace checked against the approved list BEFORE anything is spawned. None
// of that is new code — it is the same auth and allowlist the rest of the binary
// uses, which is the point of putting the shim in this repository rather than
// writing a second implementation.
package agenthost

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/navjyotnishant/specter-agent/internal/exec"
	"github.com/navjyotnishant/specter-agent/internal/hostops"
	"github.com/navjyotnishant/specter-agent/internal/isolation"
	"github.com/navjyotnishant/specter-agent/internal/models"
)

// DefaultAddr is loopback-only. A host spawner reachable from the network is a
// remote code execution service; the container reaches it through Docker's
// host-gateway mapping, which does not require binding a public interface.
const DefaultAddr = "127.0.0.1:8765"

// SpawnRequest is one agent invocation.
type SpawnRequest struct {
	Agent     string `json:"agent"`
	Prompt    string `json:"prompt"`
	Workspace string `json:"workspace"`
	// TimeoutSeconds bounds the run. Zero takes the server's default rather than
	// meaning "no limit" — an unbounded agent holds a slot forever.
	TimeoutSeconds int `json:"timeout_seconds"`
}

// SpawnResponse mirrors exec.Result, plus why a request was refused.
type SpawnResponse struct {
	OK       bool   `json:"ok"`
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	ExitCode int    `json:"exit_code"`
	TimedOut bool   `json:"timed_out"`
	Err      string `json:"error,omitempty"`
	// Refused separates "the host would not run this" from "the agent failed".
	// Collapsing them sends an operator to debug an agent when the real problem
	// is an unapproved workspace.
	Refused string `json:"refused,omitempty"`
}

// Server answers spawn requests for a backend that cannot spawn its own.
type Server struct {
	// Token is the shared secret. Empty means unprovisioned, and the server
	// REFUSES to start rather than accepting unauthenticated spawn requests.
	Token string
	// AllowlistPath overrides where approved workspaces are read from.
	AllowlistPath string
	// DefaultTimeout applies when a request does not set one.
	DefaultTimeout time.Duration
	// ResolveAgent is injectable so tests do not need a real CLI installed.
	ResolveAgent func(agent string) string

	// One prober for the life of the server, because its cache lives on the
	// struct. Building a fresh one per request — which this did — throws the
	// 60-second TTL away every time, so every status call re-probed all four
	// agents: 5.5s on an endpoint the settings page polls, warm or cold.
	proberOnce sync.Once
	prober     *hostops.Prober

	sandboxOnce sync.Once
	sandboxSvc  *hostops.Sandbox
}

func (s *Server) agentProber() *hostops.Prober {
	s.proberOnce.Do(func() { s.prober = &hostops.Prober{} })
	return s.prober
}

const defaultTimeout = 10 * time.Minute

func (s *Server) timeout(requested int) time.Duration {
	if requested > 0 {
		return time.Duration(requested) * time.Second
	}
	if s.DefaultTimeout > 0 {
		return s.DefaultTimeout
	}
	return defaultTimeout
}

func (s *Server) allowlist() string {
	if s.AllowlistPath != "" {
		return s.AllowlistPath
	}
	return exec.AllowlistPath()
}

func (s *Server) resolve(agent string) string {
	if s.ResolveAgent != nil {
		return s.ResolveAgent(agent)
	}
	return exec.ResolveCLI(agentBinaries(agent), nil)
}

// agentBinaries maps an agent name to the binaries that provide it. Mirrors the
// runner's own mapping, because the two must agree about what "cursor" means.
func agentBinaries(agent string) []string {
	switch strings.ToLower(strings.TrimSpace(agent)) {
	case "codex":
		return []string{"codex"}
	case "cursor":
		return []string{"cursor-agent", "cursor"}
	case "gemini":
		return []string{"gemini"}
	default:
		return []string{"claude"}
	}
}

// Handler is the HTTP surface: a health probe and the spawn endpoint.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	// Unauthenticated on purpose. It reports only that the host is reachable,
	// which is what a backend needs to tell "misconfigured" from "down", and it
	// reveals nothing a caller could not learn by connecting.
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "service": "specter-agent-host"})
	})

	mux.HandleFunc("/spawn", s.authenticated(s.spawn))

	// The backend cannot answer these for itself: it is asking about a machine
	// it cannot see. Without them the Models page reports every agent missing
	// while the host beside it has all four working — a red UI describing a
	// healthy system, which is worse than no answer at all.
	mux.HandleFunc("/agents", s.authenticated(s.agents))
	mux.HandleFunc("/models", s.authenticated(s.models))
	// Same reason as /agents: sbx is installed on the host, not in the container.
	mux.HandleFunc("/warden", s.authenticated(func(w http.ResponseWriter, _ *http.Request) {
		// The boundaries around the agent, which runs HERE — not around the
		// container that asked.
		writeJSON(w, http.StatusOK, isolation.Warden())
	}))
	mux.HandleFunc("/sandbox", s.authenticated(s.sandbox))
	mux.HandleFunc("/sandbox/policy", s.authenticated(s.sandboxPolicy))
	return mux
}

// agents reports what this machine has installed and signed in.
func (s *Server) agents(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.agentProber().DirectCLIStatus())
}

// sandbox reports the Docker Sandbox runtime on THIS machine.
func (s *Server) sandbox(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.sandboxOps().Status())
}

// sandboxPolicy reports the network policy sbx is configured with.
func (s *Server) sandboxPolicy(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.sandboxOps().PolicyStatus())
}

func (s *Server) sandboxOps() *hostops.Sandbox {
	s.sandboxOnce.Do(func() { s.sandboxSvc = &hostops.Sandbox{} })
	return s.sandboxSvc
}

// models reports what each installed CLI here supports.
func (s *Server) models(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, models.All(r.URL.Query().Get("refresh") == "true"))
}

// authenticated rejects anything without the shared token.
func (s *Server) authenticated(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		supplied := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		// Compared in full rather than by prefix, and a missing token never
		// matches an empty configured one — the server refuses to start without
		// one, but defence in depth is cheap here.
		if s.Token == "" || strings.TrimSpace(supplied) != s.Token {
			writeJSON(w, http.StatusUnauthorized, SpawnResponse{
				Refused: "the runner token is missing or does not match",
			})
			return
		}
		next(w, r)
	}
}

func (s *Server) spawn(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, SpawnResponse{Refused: "POST only"})
		return
	}

	var req SpawnRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, SpawnResponse{Refused: "unreadable request: " + err.Error()})
		return
	}
	if strings.TrimSpace(req.Prompt) == "" {
		writeJSON(w, http.StatusBadRequest, SpawnResponse{Refused: "a prompt is required"})
		return
	}

	// Confinement is checked BEFORE resolving or spawning anything. It is the
	// security boundary of the shim: an agent that cannot be confined must not
	// be spawned at all, however it was requested.
	approved, _, err := isolation.ResolveWorkspace(req.Workspace)
	if err != nil {
		writeJSON(w, http.StatusForbidden, SpawnResponse{Refused: err.Error()})
		return
	}

	agentPath := s.resolve(req.Agent)
	if agentPath == "" {
		// Named precisely: the backend cannot see this filesystem, so "not
		// installed" has to say WHERE it is not installed.
		writeJSON(w, http.StatusNotFound, SpawnResponse{
			Refused: fmt.Sprintf("no %s CLI found on the agent host", req.Agent),
		})
		return
	}

	// Confined here too. A containerized deployment must not be the unconfined
	// one: the whole reason this shim exists is that the app is contained and
	// the agent is not, which makes the boundary around the agent the only one
	// left.
	confined, info, err := isolation.Wrap([]string{agentPath, req.Prompt}, approved)
	if err != nil {
		writeJSON(w, http.StatusForbidden, SpawnResponse{
			Refused: "could not confine the agent: " + err.Error(),
		})
		return
	}
	if info.Mechanism == isolation.MechanismNone {
		// ResolveWorkspace already refuses when no mechanism exists, so this is
		// belt and braces — but an unconfined spawn must never be silent.
		writeJSON(w, http.StatusForbidden, SpawnResponse{
			Refused: "agents cannot be confined on this host: " + info.Reason,
		})
		return
	}

	result := exec.RunStreaming(r.Context(), exec.Command{
		Argv:    confined,
		Dir:     approved,
		Env:     isolation.Env(os.Environ(), approved),
		Timeout: s.timeout(req.TimeoutSeconds),
	})

	writeJSON(w, http.StatusOK, SpawnResponse{
		OK:       result.OK(),
		Stdout:   result.Stdout,
		Stderr:   result.Stderr,
		ExitCode: result.ExitCode,
		TimedOut: result.TimedOut,
		Err:      result.Err,
	})
}

func writeJSON(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}
