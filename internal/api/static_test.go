// Serving the built frontend.
//
// The API alone is not the product: without this the container has no UI, and
// every deep link (/workflows/abc/builder) 404s because those routes exist only
// in the browser's router.
//
// The rule that makes it work is also the one that makes it dangerous: unknown
// paths fall back to index.html. A fallback that first tries to read the
// requested file must never be talked into reading a file outside the frontend
// directory.
package api

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func frontendDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "assets"), 0o755)
	os.WriteFile(filepath.Join(dir, "index.html"), []byte("<!doctype html><title>Specter</title>"), 0o644)
	os.WriteFile(filepath.Join(dir, "assets", "app.js"), []byte("console.log(1)"), 0o644)
	os.WriteFile(filepath.Join(dir, "favicon.ico"), []byte("icon"), 0o644)
	return dir
}

func staticServer(t *testing.T, dir string) *server2 {
	t.Helper()
	s, err := openTestStore(t)
	if err != nil {
		t.Fatal(err)
	}
	return newServer2(t, &Deps{Store: s, FrontendDir: dir})
}

func TestIndexIsServedAtTheRoot(t *testing.T) {
	srv := staticServer(t, frontendDir(t))
	code, body := srv.raw(t, "GET", "/")
	if code != http.StatusOK {
		t.Fatalf("/ returned %d", code)
	}
	if !strings.Contains(body, "Specter") {
		t.Errorf("the root did not serve index.html: %q", body)
	}
}

func TestAssetsAreServedWithTheirOwnContent(t *testing.T) {
	srv := staticServer(t, frontendDir(t))
	code, body := srv.raw(t, "GET", "/assets/app.js")
	if code != http.StatusOK {
		t.Fatalf("returned %d", code)
	}
	if !strings.Contains(body, "console.log") {
		t.Errorf("an asset fell back to index.html — the page would load with no JavaScript: %q", body)
	}
}

func TestAClientRouteFallsBackToIndex(t *testing.T) {
	// /workflows/abc/builder exists only in the browser's router. Without the
	// fallback, refreshing that page or opening a shared link 404s.
	srv := staticServer(t, frontendDir(t))
	for _, path := range []string{"/dashboard", "/workflows", "/workflows/abc/builder", "/settings/models"} {
		code, body := srv.raw(t, "GET", path)
		if code != http.StatusOK {
			t.Errorf("%s returned %d — a deep link would 404", path, code)
		}
		if !strings.Contains(body, "Specter") {
			t.Errorf("%s did not serve index.html", path)
		}
	}
}

func TestTheAPIIsNotShadowedByTheFallback(t *testing.T) {
	// The catch-all is registered last for exactly this reason. If it swallowed
	// /api, every endpoint would return HTML and the app would break in a way
	// that looks like a frontend bug.
	srv := staticServer(t, frontendDir(t))

	code, body := srv.raw(t, "GET", "/api/health")
	if code != http.StatusOK {
		t.Fatalf("/api/health returned %d", code)
	}
	if strings.Contains(body, "<!doctype") {
		t.Error("an API route served index.html — the fallback is shadowing /api")
	}

	// An unknown API path must 404 as JSON, not fall through to the SPA. A
	// client that gets HTML back reports "unexpected token <" instead of 404.
	code, body = srv.raw(t, "GET", "/api/does-not-exist")
	if code != http.StatusNotFound {
		t.Errorf("an unknown API path returned %d, want 404", code)
	}
	if strings.Contains(body, "<!doctype") {
		t.Error("an unknown API path served HTML")
	}
}

func TestPathTraversalCannotEscapeTheFrontendDirectory(t *testing.T) {
	// The fallback reads the requested path before giving up, so it must not be
	// talked into reading a file outside the directory. The Python version does
	// `frontend_dir / full_path` with no containment check.
	dir := frontendDir(t)
	secret := filepath.Join(filepath.Dir(dir), "secret.txt")
	os.WriteFile(secret, []byte("SENSITIVE-CONTENT"), 0o600)

	srv := staticServer(t, dir)
	for _, path := range []string{
		"/../secret.txt",
		"/assets/../../secret.txt",
		"/..%2fsecret.txt",
		"/....//secret.txt",
	} {
		code, body := srv.raw(t, "GET", path)
		if strings.Contains(body, "SENSITIVE-CONTENT") {
			t.Errorf("%s escaped the frontend directory and read a file outside it (%d)", path, code)
		}
	}
}

func TestNoFrontendDirectoryStillServesTheAPI(t *testing.T) {
	// `specter serve` on a developer's machine has no built frontend. The API
	// must work anyway, and a request for a page should say so rather than
	// crashing.
	srv := staticServer(t, "")

	if code, _ := srv.raw(t, "GET", "/api/health"); code != http.StatusOK {
		t.Errorf("the API stopped working without a frontend directory (%d)", code)
	}
	if code, _ := srv.raw(t, "GET", "/dashboard"); code != http.StatusNotFound {
		t.Errorf("a page request with no frontend returned %d, want 404", code)
	}
}

func TestIndexIsNotCachedButAssetsAre(t *testing.T) {
	// Vite fingerprints asset filenames, so they are safe to cache forever.
	// index.html is not fingerprinted — caching it serves a stale page that
	// references assets which no longer exist after a deploy.
	srv := staticServer(t, frontendDir(t))

	indexCache := srv.header(t, "GET", "/", "Cache-Control")
	if !strings.Contains(indexCache, "no-cache") && !strings.Contains(indexCache, "no-store") {
		t.Errorf("index.html Cache-Control = %q — a stale index outlives a deploy", indexCache)
	}
	assetCache := srv.header(t, "GET", "/assets/app.js", "Cache-Control")
	if !strings.Contains(assetCache, "max-age") {
		t.Errorf("assets Cache-Control = %q — fingerprinted assets should cache", assetCache)
	}
}
