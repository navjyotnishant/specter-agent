// Package api serves the HTTP surface the React frontend already speaks.
//
// The route paths are not a design decision here — they are a constraint. The
// frontend is unchanged, so every path, method, and status code has to match
// what FastAPI served. Where this file looks like it is following someone
// else's shape, it is.
package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"sync"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/navjyotnishant/specter-agent/internal/auth"
	"github.com/navjyotnishant/specter-agent/internal/hostops"
	"github.com/navjyotnishant/specter-agent/internal/store"
)

// Deps is what the handlers need. Passed explicitly rather than reached for
// through package state, so a test can hand over a temp database.
type Deps struct {
	Store *store.Store
	// DBPath is reported by /api/health, which external monitors read.
	DBPath string
	// SchedulerEnabled is false until the Go scheduler is ported. Reporting
	// "active" for something not running is worse than reporting the gap.
	SchedulerEnabled bool
	// CORSOrigins defaults to DefaultCORSOrigins when empty.
	CORSOrigins []string
	// AgentPath overrides agent CLI resolution. Set by tests so a run can be
	// driven by a fake agent; empty means resolve the agent named on the node.
	AgentPath string
	// FrontendDir holds the built single-page app. Empty means API only, which
	// is the normal case for `specter serve` on a developer's machine.
	FrontendDir string
	// SecretsPath overrides where the integration key lives. Empty means the
	// same location the Python backend uses, so credentials saved by either are
	// readable by both.
	SecretsPath string
	// Prober, Service and Sandbox are injectable so tests do not touch the real
	// machine.
	Prober  *hostops.Prober
	Service *hostops.Service
	Sandbox *hostops.Sandbox

	// The prober used when none is injected. Held here rather than built per
	// request because its cache lives on the struct — a fresh one every request
	// means the cache never survives to be used.
	proberOnce   sync.Once
	sharedProber *hostops.Prober
}

type contextKey string

const userKey contextKey = "user"

// NewRouter wires the whole surface.
func NewRouter(deps *Deps) http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.Recoverer) // a panic in one handler must not kill the server

	origins := deps.CORSOrigins
	if len(origins) == 0 {
		origins = DefaultCORSOrigins
	}
	r.Use(cors(origins))

	r.Route("/api", func(r chi.Router) {
		r.Get("/health", deps.health)
		r.Get("/health/system", deps.systemHealth)
		r.Route("/approvals", func(r chi.Router) {
			r.Use(deps.requireUser)
			r.Get("/", deps.listApprovals)
			r.Get("/{approvalID}", deps.getApproval)
			// The same resolutions as the run-scoped routes. Both paths exist in
			// the Python API and the frontend uses both, so dropping either
			// would break a screen that works today.
			r.With(requireAdmin).Post("/{approvalID}/approve", deps.resolveApprovalByID("approved"))
			r.With(requireAdmin).Post("/{approvalID}/reject", deps.resolveApprovalByID("rejected"))
			r.With(requireAdmin).Post("/{approvalID}/request-revision", deps.resolveApprovalByID("revision_requested"))
		})
		// memory.py has no authentication in Python -- issue #40. DELETE wipes
		// a run's memory with no session at all. This port requires one.
		r.Route("/runs", func(r chi.Router) {
			r.Use(deps.requireUser)
			r.Get("/{runID}/events", deps.runEvents)
			r.Get("/{runID}/memory", deps.runMemory)
			r.With(requireAdmin).Post("/security-review-demo", deps.startRun)
			r.Delete("/{runID}/memory", deps.clearRunMemory)
		})
		r.Route("/runtime-adapters", func(r chi.Router) {
			r.Use(deps.requireUser)
			r.Get("/direct-cli/status", deps.directCLIStatus)
			r.Get("/codex-cli/status", deps.codexCLIStatus)
			r.Get("/workspaces", deps.listWorkspaces)
			r.Get("/host-runner/launchd/status", deps.launchdStatus)
			r.Get("/mcp/list", deps.mcpList)
			// The Warden: which boundaries hold right now. Same report the CLI
			// prints, so the two cannot disagree about what is protecting you.
			r.Get("/warden", deps.warden)
			r.Get("/docker-sandbox/status", deps.sandboxStatus)
			r.Get("/docker-sandbox/policy", deps.sandboxPolicy)
			r.Get("/models", deps.agentModels)
			r.Get("/host-runner/version", deps.hostRunnerVersion)
			r.Get("/host-runner/mode", deps.hostRunnerMode)
			r.Get("/host-runner/logs", deps.hostRunnerLogs)
			r.Get("/codex-cli/runs", deps.listCodexRuns)
			r.Get("/mcp/login/{name}", deps.mcpLoginInstructions)

			r.Group(func(r chi.Router) {
				r.Use(requireAdmin)
				// The workspace list IS the agent allowlist: whoever can add to
				// it can point an agent at any directory on this machine.
				r.Post("/workspaces", deps.createWorkspace)
				r.Delete("/workspaces/{workspaceID}", deps.deactivateWorkspace)
				r.Get("/telegram/config", deps.telegramConfig)
				r.Post("/telegram/config", deps.saveTelegramConfig)
				r.Delete("/telegram/config", deps.deleteTelegramConfig)
				r.Post("/mcp/add", deps.mcpAdd)
				r.Post("/mcp/remove/{name}", deps.mcpRemove)
				r.Post("/host-runner/launchd/install", deps.launchdAction("install"))
				r.Post("/host-runner/launchd/uninstall", deps.launchdAction("uninstall"))
				r.Post("/host-runner/launchd/restart", deps.launchdAction("restart"))
				r.Post("/docker-sandbox/daemon/start", deps.sandboxDaemonStart)
				r.Post("/docker-sandbox/policy", deps.setSandboxPolicy)
				r.Post("/repositories/discover", deps.discoverRepositories)
				r.Post("/host-runner/mode", deps.hostRunnerMode)
				r.Post("/telegram/discover-chats", deps.telegramDiscoverChats)
				r.Post("/repositories/parse", deps.parseRepository)
				r.Post("/repositories/clone", deps.cloneRepository)
				r.Post("/codex-cli/runs", deps.startCodexRun)
				r.Post("/codex-cli/install", deps.codexInstaller("install"))
				r.Post("/codex-cli/upgrade", deps.codexInstaller("upgrade"))
			})
		})
		r.Route("/workflows", func(r chi.Router) {
			r.Use(deps.requireUser)
			r.Get("/", deps.listWorkflows)
			r.Post("/", deps.createWorkflow)
			// Planning RUNS AN AGENT in the workspace, so it takes the same
			// allowlist check as starting a run rather than being treated as a
			// read-only preview.
			r.Post("/plan", deps.planWorkflow)
			r.Post("/plan/tune-node", deps.tuneNode)
			r.Get("/{workflowID}", deps.getWorkflow)
			r.Patch("/{workflowID}", deps.updateWorkflow)
			r.Delete("/{workflowID}", deps.deleteWorkflow)
			r.Patch("/{workflowID}/publish-template", deps.setTemplateFlag(true))
			r.Patch("/{workflowID}/unpublish-template", deps.setTemplateFlag(false))
		})
		r.Route("/skills", func(r chi.Router) {
			r.Use(deps.requireUser)
			r.Get("/", deps.listSkills)
			r.Post("/", deps.createSkill)
			r.Get("/{skillID}", deps.getSkill)
			r.Patch("/{skillID}", deps.updateSkill)
			r.Delete("/{skillID}", deps.deleteSkill)
		})
		// agents.py has no authentication in Python -- issue #40, nine open
		// endpoints. This port requires a session rather than reproducing it.
		r.Route("/agents", func(r chi.Router) {
			r.Use(deps.requireUser)
			r.Get("/", deps.listAgents)
			r.Post("/", deps.createAgent)
			r.Get("/{agentID}", deps.getAgent)
			r.Patch("/{agentID}", deps.updateAgent)
			r.Delete("/{agentID}", deps.deleteAgent)
		})
		r.Route("/connectors", func(r chi.Router) {
			r.Use(deps.requireUser)
			r.Get("/", deps.listConnectors)
			r.Post("/", deps.createConnector)
			r.Patch("/{connectorID}", deps.updateConnector)
			r.Delete("/{connectorID}", deps.deleteConnector)
		})
		r.Route("/model-providers", func(r chi.Router) {
			r.Use(deps.requireUser)
			r.Get("/", deps.listModelProviders)
			r.Post("/", deps.createModelProvider)
			r.Patch("/{providerID}", deps.updateModelProvider)
			r.Delete("/{providerID}", deps.deleteModelProvider)
		})
		r.Route("/workflow-runs", func(r chi.Router) {
			r.Use(deps.requireUser)
			// /stats is registered before /{runID} so the wildcard cannot
			// shadow it — otherwise the dashboard's stats call 404s looking for
			// a run named "stats".
			r.Get("/stats", deps.runStats)
			// Starting a run spawns an agent against a repository. Reading runs
			// is not the same permission as starting one.
			r.With(requireAdmin).Post("/", deps.startRun)
			r.With(requireAdmin).Post("/{runID}/cancel", deps.cancelRunHandler)
			r.With(requireAdmin).Post("/{runID}/approve/{approvalID}", deps.resolveApproval("approved"))
			r.With(requireAdmin).Post("/{runID}/reject/{approvalID}", deps.resolveApproval("rejected"))
			r.With(requireAdmin).Post("/{runID}/request-revision/{approvalID}", deps.resolveApproval("revision_requested"))
			r.Get("/", deps.listRuns)
			r.Get("/{runID}", deps.getRun)
			r.Get("/{runID}/steps", deps.runSteps)
			r.Get("/{runID}/logs", deps.runLogs)
			r.Get("/{runID}/steps/{stepID}/messages", deps.stepMessages)
			r.Get("/{runID}/approvals", deps.runApprovals)
			// Also under /workflow-runs, where the rest of the run surface
			// lives. Python only had /runs/{id}/events; the frontend polls
			// instead of subscribing, so both paths exist for API parity rather
			// than because one is in use.
			r.Get("/{runID}/events", deps.runEvents)
		})
		r.Route("/auth", func(r chi.Router) {
			// Open by necessity: these are what you call BEFORE you have a
			// session. Everything else on this router is gated.
			r.Get("/status", deps.authStatus)
			r.Post("/bootstrap", deps.bootstrap)
			r.Post("/login", deps.login)
			r.Post("/logout", deps.logout) // safe: revokes whatever token it is given

			r.Group(func(r chi.Router) {
				r.Use(deps.requireUser)
				r.Get("/me", deps.me)
				r.Post("/password", deps.changeOwnPassword)
			})
			r.Group(func(r chi.Router) {
				r.Use(deps.requireUser, requireAdmin)
				r.Get("/users", deps.listUsers)
				r.Post("/users", deps.createUser)
				r.Delete("/users/{userID}", deps.deleteUser)
				r.Patch("/users/{userID}/role", deps.changeUserRole)
				r.Post("/users/{userID}/password", deps.resetUserPassword)
			})
		})
	})

	// LAST, so every real route wins over the catch-all.
	deps.mountFrontend(r)
	return r
}

// chiRouter is the slice of chi's interface the frontend mount needs.
type chiRouter interface {
	NotFound(http.HandlerFunc)
}

// --- middleware ---

// requireUser resolves the bearer token, or 401s.
func (d *Deps) requireUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := auth.BearerToken(r.Header.Get("Authorization"))
		if token == "" {
			writeError(w, http.StatusUnauthorized, "Authentication required")
			return
		}
		user, err := auth.UserForToken(d.Store, token)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Could not verify the session")
			return
		}
		if user == nil {
			writeError(w, http.StatusUnauthorized, "Invalid or expired session")
			return
		}
		next.ServeHTTP(w, r.WithContext(withUser(r.Context(), user)))
	})
}

// requireAdmin runs AFTER requireUser and returns 403, not 401 — the caller is
// authenticated, just not permitted. A 401 here would make the UI bounce them
// to a login screen they have already passed.
func requireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user := userFrom(r)
		if user == nil || user.Role != "admin" {
			writeError(w, http.StatusForbidden, "Admin access required")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// --- helpers ---

func writeJSON(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(body)
}

// writeError uses "detail" because that is FastAPI's error shape, and the
// frontend already reads it.
func writeError(w http.ResponseWriter, code int, detail string) {
	writeJSON(w, code, map[string]string{"detail": detail})
}

func decode(r *http.Request, into any) error {
	if err := json.NewDecoder(r.Body).Decode(into); err != nil {
		return errors.New("Invalid request body")
	}
	return nil
}

// health actually probes the database rather than returning a constant.
//
// A health endpoint that answers "ok" without touching anything reports healthy
// while the database is unreachable, which is exactly when someone is reading
// it. The shape matches Python's — the frontend and any external monitor read
// these keys.
func (d *Deps) health(w http.ResponseWriter, _ *http.Request) {
	sqliteStatus := "unavailable"
	journalMode := "unknown"

	var probe int
	if err := d.Store.DB().QueryRow(`SELECT 1`).Scan(&probe); err != nil {
		sqliteStatus = "error: " + err.Error()
	} else {
		sqliteStatus = "healthy"
		d.Store.DB().QueryRow(`PRAGMA journal_mode`).Scan(&journalMode)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"api":          "ok",
		"sqlite":       sqliteStatus,
		"journal_mode": journalMode,
		"db_path":      d.DBPath,
		"scheduler":    d.SchedulerStatus(),
		"runtime":      "local",
	})
}

// SchedulerStatus reports whether scheduled triggers are running. The Go
// scheduler is not ported yet, so this says "disabled" rather than claiming an
// "active" it cannot deliver — a status line that overstates what is running is
// worse than one that admits a gap.
func (d *Deps) SchedulerStatus() string {
	if d.SchedulerEnabled {
		return "active"
	}
	return "disabled"
}

func jsonUnmarshalInto(raw string, into any) {
	// Best effort: a malformed run_input should not stop a resume.
	json.Unmarshal([]byte(raw), into)
}
