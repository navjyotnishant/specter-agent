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
	"strings"
	"time"

	"github.com/navjyotnishant/specter-agent/internal/exec"
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
	return mux
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

	// The allowlist is checked BEFORE resolving or spawning anything. This is
	// the whole security boundary of the shim: without it, anything that can
	// reach the port can run an agent against any directory on the machine.
	approved, reason := exec.ApprovedWorkspace(req.Workspace, s.allowlist())
	if approved == "" {
		writeJSON(w, http.StatusForbidden, SpawnResponse{Refused: reason})
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

	result := exec.RunStreaming(r.Context(), exec.Command{
		Argv:    []string{agentPath, req.Prompt},
		Dir:     approved,
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
