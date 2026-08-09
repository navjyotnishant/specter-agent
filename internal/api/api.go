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

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/navjyotnishant/specter-agent/internal/auth"
	"github.com/navjyotnishant/specter-agent/internal/store"
)

// Deps is what the handlers need. Passed explicitly rather than reached for
// through package state, so a test can hand over a temp database.
type Deps struct {
	Store *store.Store
}

type contextKey string

const userKey contextKey = "user"

// NewRouter wires the whole surface.
func NewRouter(deps *Deps) http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.Recoverer) // a panic in one handler must not kill the server

	r.Route("/api", func(r chi.Router) {
		r.Get("/health", func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
		})
		r.Route("/workflows", func(r chi.Router) {
			r.Use(deps.requireUser)
			r.Get("/", deps.listWorkflows)
			r.Post("/", deps.createWorkflow)
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
	return r
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
