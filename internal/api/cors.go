package api

import (
	"net/http"
	"strings"
)

// DefaultCORSOrigins matches backend/app/core/config.py. The Vite dev server
// and a plain React dev server; production serves the frontend from the same
// origin and needs none of this.
var DefaultCORSOrigins = []string{
	"http://localhost:5173", "http://localhost:3000",
	"http://127.0.0.1:5173", "http://127.0.0.1:3000",
	"http://localhost:8080", "http://127.0.0.1:8080",
}

// cors answers preflights and stamps the response headers a browser requires.
//
// This is not optional glue: without it every request from the frontend fails
// at the preflight and the app cannot load at all. curl does not enforce CORS,
// so an API can pass every command-line check and still be unreachable from a
// browser — which is exactly how this was missed until the real UI was pointed
// at it.
//
// The origin is echoed from an explicit allowlist rather than answered with
// "*". Wildcard and Access-Control-Allow-Credentials are mutually exclusive per
// the spec, and the client sends a bearer token.
func cors(allowed []string) func(http.Handler) http.Handler {
	allowedSet := make(map[string]bool, len(allowed))
	for _, origin := range allowed {
		allowedSet[strings.TrimSpace(origin)] = true
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if origin != "" && allowedSet[origin] {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Access-Control-Allow-Credentials", "true")
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
				w.Header().Set("Access-Control-Max-Age", "600")
				// Responses vary by Origin; without this a cache can serve one
				// origin's headers to another.
				w.Header().Add("Vary", "Origin")
			}
			if r.Method == http.MethodOptions {
				// Preflight ends here — never fall through to a handler, which
				// would run the request the preflight was only asking about.
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
