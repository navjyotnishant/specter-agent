package api

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// mountFrontend serves the built single-page app.
//
// Registered LAST, so /api is matched first. A catch-all that swallowed /api
// would return HTML from every endpoint, and the app would break in a way that
// looks like a frontend bug rather than a routing one.
func (d *Deps) mountFrontend(r chiRouter) {
	if d.FrontendDir == "" {
		return
	}
	root, err := filepath.EvalSymlinks(d.FrontendDir)
	if err != nil {
		// No built frontend — `specter serve` on a developer's machine. The API
		// still works; a page request 404s, which is the honest answer.
		return
	}

	r.NotFound(func(w http.ResponseWriter, req *http.Request) {
		// /api is handled by real routes. Anything unmatched under it is a
		// missing endpoint, and answering with HTML makes a client report
		// "unexpected token <" instead of 404.
		if strings.HasPrefix(req.URL.Path, "/api") {
			writeError(w, http.StatusNotFound, "Not found")
			return
		}
		serveSPA(w, req, root)
	})
}

// serveSPA serves a real file when one exists, and index.html otherwise.
//
// The fallback is what makes client-side routes work: /workflows/abc/builder
// exists only in the browser's router, so refreshing that page or opening a
// shared link has to return the app rather than 404.
func serveSPA(w http.ResponseWriter, r *http.Request, root string) {
	// CONTAINMENT FIRST. The fallback reads the requested path before giving
	// up, so a traversal would otherwise read any file the process can reach.
	// path.Clean on a rooted path collapses .. before it can escape.
	clean := filepath.Clean("/" + strings.TrimPrefix(r.URL.Path, "/"))
	candidate := filepath.Join(root, clean)

	// Belt and braces: even after cleaning, verify the result is inside root.
	// Symlinks inside the frontend directory could otherwise point outside it.
	if resolved, err := filepath.EvalSymlinks(candidate); err == nil {
		if resolved != root && !strings.HasPrefix(resolved, root+string(filepath.Separator)) {
			http.NotFound(w, r)
			return
		}
		candidate = resolved
	}

	if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
		// Fingerprinted by Vite, so safe to cache indefinitely.
		if strings.HasPrefix(clean, "/assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		}
		http.ServeFile(w, r, candidate)
		return
	}

	index := filepath.Join(root, "index.html")
	if _, err := os.Stat(index); err != nil {
		http.NotFound(w, r)
		return
	}
	// index.html is NOT fingerprinted. Caching it serves a stale page after a
	// deploy, referencing asset filenames that no longer exist.
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeFile(w, r, index)
}
