// Tests written before the handlers.
//
// The Python auth router carries five rules that are cheap to drop in a port
// and expensive to discover missing. Each one is a lockout or a takeover:
//
//  1. The last admin cannot be demoted   — nobody can manage users again
//  2. An admin cannot delete themselves  — same, one step faster
//  3. A password reset kills sessions    — a "reset" that leaves them live
//     has not locked anyone out
//  4. Changing your own password needs   — else a stolen session token is a
//     the current one                      permanent account takeover
//  5. Passwords cap at 72 bytes          — bcrypt ignores the rest, so the
//     user believes they set something
//     stronger than what guards them
//
// They are asserted here against real HTTP through the real router, not by
// calling handlers directly — the middleware is part of the behaviour.
package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/navjyotnishant/specter-agent/internal/store"
)

func testServer(t *testing.T) (*httptest.Server, *store.Store) {
	t.Helper()
	s, err := store.Open(t.TempDir() + "/app.db")
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(NewRouter(&Deps{Store: s}))
	t.Cleanup(func() { srv.Close(); s.Close() })
	return srv, s
}

// call issues a request and decodes the JSON body if there is one.
func call(t *testing.T, srv *httptest.Server, method, path, token string, body any) (int, map[string]any) {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		reader = bytes.NewReader(raw)
	} else {
		reader = bytes.NewReader(nil)
	}
	req, err := http.NewRequest(method, srv.URL+path, reader)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	var out map[string]any
	json.NewDecoder(resp.Body).Decode(&out) // a body is optional
	return resp.StatusCode, out
}

// bootstrapAdmin creates the first admin and returns its token.
func bootstrapAdmin(t *testing.T, srv *httptest.Server) (string, string) {
	t.Helper()
	code, _ := call(t, srv, "POST", "/api/auth/bootstrap", "",
		map[string]string{"email": "admin@local.dev", "password": "hunter2hunter2"})
	if code != http.StatusOK {
		t.Fatalf("bootstrap failed: %d", code)
	}
	code, body := call(t, srv, "POST", "/api/auth/login", "",
		map[string]string{"email": "admin@local.dev", "password": "hunter2hunter2"})
	if code != http.StatusOK {
		t.Fatalf("login failed: %d", code)
	}
	token, _ := body["token"].(string)
	user, _ := body["user"].(map[string]any)
	id, _ := user["id"].(string)
	if token == "" || id == "" {
		t.Fatalf("login returned no token/user: %+v", body)
	}
	return token, id
}

func TestHealthNeedsNoAuth(t *testing.T) {
	srv, _ := testServer(t)
	if code, _ := call(t, srv, "GET", "/api/health", "", nil); code != http.StatusOK {
		t.Errorf("health returned %d — it must work before anyone can sign in", code)
	}
}

func TestStatusReportsSetupThenStopsReporting(t *testing.T) {
	srv, _ := testServer(t)
	_, body := call(t, srv, "GET", "/api/auth/status", "", nil)
	if body["needs_setup"] != true {
		t.Error("a fresh install should report needs_setup")
	}
	bootstrapAdmin(t, srv)
	_, body = call(t, srv, "GET", "/api/auth/status", "", nil)
	if body["needs_setup"] != false {
		t.Error("still reporting needs_setup after bootstrap — the setup screen would reappear")
	}
}

func TestBootstrapOnlyWorksOnce(t *testing.T) {
	// A second bootstrap would mint an admin on a live system with no credential.
	srv, _ := testServer(t)
	bootstrapAdmin(t, srv)
	code, _ := call(t, srv, "POST", "/api/auth/bootstrap", "",
		map[string]string{"email": "attacker@evil.dev", "password": "hunter2hunter2"})
	if code != http.StatusConflict {
		t.Errorf("second bootstrap returned %d, want 409", code)
	}
}

func TestProtectedRoutesRejectMissingAndBadTokens(t *testing.T) {
	srv, _ := testServer(t)
	token, _ := bootstrapAdmin(t, srv)

	for _, tc := range []struct{ name, token string }{
		{"no token", ""},
		{"garbage token", "not-a-real-token"},
		{"empty bearer", " "},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if code, _ := call(t, srv, "GET", "/api/auth/me", tc.token, nil); code != http.StatusUnauthorized {
				t.Errorf("got %d, want 401", code)
			}
		})
	}
	if code, _ := call(t, srv, "GET", "/api/auth/me", token, nil); code != http.StatusOK {
		t.Error("a valid token was rejected")
	}
}

func TestLogoutRevokesTheToken(t *testing.T) {
	srv, _ := testServer(t)
	token, _ := bootstrapAdmin(t, srv)

	if code, _ := call(t, srv, "POST", "/api/auth/logout", token, nil); code != http.StatusOK {
		t.Fatal("logout failed")
	}
	if code, _ := call(t, srv, "GET", "/api/auth/me", token, nil); code != http.StatusUnauthorized {
		t.Errorf("the token still works after logout (%d) — logout did nothing", code)
	}
}

func TestOperatorCannotReachAdminRoutes(t *testing.T) {
	srv, _ := testServer(t)
	adminToken, _ := bootstrapAdmin(t, srv)

	code, _ := call(t, srv, "POST", "/api/auth/users", adminToken,
		map[string]string{"email": "op@local.dev", "password": "hunter2hunter2", "role": "operator"})
	if code != http.StatusOK {
		t.Fatalf("creating the operator failed: %d", code)
	}
	_, body := call(t, srv, "POST", "/api/auth/login", "",
		map[string]string{"email": "op@local.dev", "password": "hunter2hunter2"})
	opToken, _ := body["token"].(string)

	if code, _ := call(t, srv, "GET", "/api/auth/users", opToken, nil); code != http.StatusForbidden {
		t.Errorf("an operator listed users (%d), want 403", code)
	}
	// 403 not 401: the operator IS authenticated, just not permitted. Returning
	// 401 makes the UI bounce them to a login they have already passed.
	if code, _ := call(t, srv, "GET", "/api/auth/me", opToken, nil); code != http.StatusOK {
		t.Error("the operator's own token stopped working")
	}
}

// --- the five load-bearing rules ---

func TestLastAdminCannotBeDemoted(t *testing.T) {
	srv, _ := testServer(t)
	token, adminID := bootstrapAdmin(t, srv)

	code, body := call(t, srv, "PATCH", "/api/auth/users/"+adminID+"/role", token,
		map[string]string{"role": "operator"})
	if code != http.StatusBadRequest {
		t.Fatalf("demoting the only admin returned %d, want 400 — this locks everyone out of user management", code)
	}
	if detail, _ := body["detail"].(string); !strings.Contains(strings.ToLower(detail), "admin") {
		t.Errorf("the error does not explain the problem: %q", detail)
	}

	// With a second admin it must succeed — the rule is "not the last one",
	// not "never".
	call(t, srv, "POST", "/api/auth/users", token,
		map[string]string{"email": "admin2@local.dev", "password": "hunter2hunter2", "role": "admin"})
	if code, _ := call(t, srv, "PATCH", "/api/auth/users/"+adminID+"/role", token,
		map[string]string{"role": "operator"}); code != http.StatusOK {
		t.Errorf("demotion blocked even with a second admin (%d)", code)
	}
}

func TestAdminCannotDeleteThemselves(t *testing.T) {
	srv, _ := testServer(t)
	token, adminID := bootstrapAdmin(t, srv)
	if code, _ := call(t, srv, "DELETE", "/api/auth/users/"+adminID, token, nil); code != http.StatusBadRequest {
		t.Errorf("self-delete returned %d, want 400", code)
	}
}

func TestPasswordResetInvalidatesExistingSessions(t *testing.T) {
	srv, _ := testServer(t)
	adminToken, _ := bootstrapAdmin(t, srv)

	call(t, srv, "POST", "/api/auth/users", adminToken,
		map[string]string{"email": "op@local.dev", "password": "hunter2hunter2", "role": "operator"})
	_, body := call(t, srv, "POST", "/api/auth/login", "",
		map[string]string{"email": "op@local.dev", "password": "hunter2hunter2"})
	opToken, _ := body["token"].(string)
	opUser, _ := body["user"].(map[string]any)
	opID, _ := opUser["id"].(string)

	if code, _ := call(t, srv, "GET", "/api/auth/me", opToken, nil); code != http.StatusOK {
		t.Fatal("the operator's session did not work to begin with")
	}
	if code, _ := call(t, srv, "POST", "/api/auth/users/"+opID+"/password", adminToken,
		map[string]string{"password": "brandnewpassword"}); code != http.StatusOK {
		t.Fatal("the reset failed")
	}
	if code, _ := call(t, srv, "GET", "/api/auth/me", opToken, nil); code != http.StatusUnauthorized {
		t.Errorf("the old session survived the reset (%d) — the user is not locked out", code)
	}
}

func TestChangingOwnPasswordRequiresTheCurrentOne(t *testing.T) {
	// Otherwise a stolen session token is a permanent account takeover.
	srv, _ := testServer(t)
	token, _ := bootstrapAdmin(t, srv)

	code, _ := call(t, srv, "POST", "/api/auth/password", token,
		map[string]string{"current_password": "wrong-password", "new_password": "brandnewpassword"})
	if code != http.StatusForbidden {
		t.Errorf("changed the password without the current one (%d), want 403", code)
	}
	if code, _ := call(t, srv, "POST", "/api/auth/password", token,
		map[string]string{"current_password": "hunter2hunter2", "new_password": "brandnewpassword"}); code != http.StatusOK {
		t.Errorf("the correct current password was rejected (%d)", code)
	}
	if code, _ := call(t, srv, "POST", "/api/auth/login", "",
		map[string]string{"email": "admin@local.dev", "password": "brandnewpassword"}); code != http.StatusOK {
		t.Error("the new password does not work")
	}
}

func TestPasswordLengthRules(t *testing.T) {
	srv, _ := testServer(t)
	token, _ := bootstrapAdmin(t, srv)

	cases := []struct {
		name     string
		password string
		want     int
	}{
		{"too short", "short", http.StatusBadRequest},
		{"at the minimum", "12345678", http.StatusOK},
		// bcrypt ignores everything past 72 bytes. Accepting a longer one lets a
		// user believe they set something stronger than what guards the account.
		{"over 72 bytes", strings.Repeat("x", 73), http.StatusBadRequest},
		// Multi-byte characters count as BYTES, not runes: 40 two-byte chars is
		// 80 bytes. Counting runes here would let a password past the cap.
		{"73+ bytes via unicode", strings.Repeat("é", 40), http.StatusBadRequest},
	}
	for i, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			email := "user" + string(rune('a'+i)) + "@local.dev"
			code, _ := call(t, srv, "POST", "/api/auth/users", token,
				map[string]string{"email": email, "password": c.password, "role": "operator"})
			if code != c.want {
				t.Errorf("password %q: got %d, want %d", c.name, code, c.want)
			}
		})
	}
}

func TestDuplicateEmailIsAConflict(t *testing.T) {
	srv, _ := testServer(t)
	token, _ := bootstrapAdmin(t, srv)
	body := map[string]string{"email": "op@local.dev", "password": "hunter2hunter2", "role": "operator"}

	if code, _ := call(t, srv, "POST", "/api/auth/users", token, body); code != http.StatusOK {
		t.Fatal("the first create failed")
	}
	if code, _ := call(t, srv, "POST", "/api/auth/users", token, body); code != http.StatusConflict {
		t.Errorf("the duplicate returned %d, want 409", code)
	}
}

func TestInvalidRoleIsRejected(t *testing.T) {
	srv, _ := testServer(t)
	token, _ := bootstrapAdmin(t, srv)
	if code, _ := call(t, srv, "POST", "/api/auth/users", token,
		map[string]string{"email": "x@local.dev", "password": "hunter2hunter2", "role": "superuser"}); code != http.StatusBadRequest {
		t.Errorf("an unknown role was accepted (%d)", code)
	}
}

func TestPasswordHashNeverLeavesTheServer(t *testing.T) {
	// The single worst thing this API could do.
	srv, _ := testServer(t)
	token, _ := bootstrapAdmin(t, srv)

	for _, path := range []string{"/api/auth/me", "/api/auth/users"} {
		req, _ := http.NewRequest("GET", srv.URL+path, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		var raw bytes.Buffer
		raw.ReadFrom(resp.Body)
		resp.Body.Close()
		if strings.Contains(raw.String(), "password_hash") || strings.Contains(raw.String(), "$2b$") {
			t.Errorf("%s leaked a password hash", path)
		}
	}
}

func TestUnknownRouteIs404NotAPanic(t *testing.T) {
	srv, _ := testServer(t)
	if code, _ := call(t, srv, "GET", "/api/nope", "", nil); code != http.StatusNotFound {
		t.Errorf("got %d, want 404", code)
	}
}

func TestAuthTokenIsNotLoggedOrEchoed(t *testing.T) {
	// A token echoed into a response body ends up in browser history, proxy
	// logs, and error trackers.
	srv, _ := testServer(t)
	token, _ := bootstrapAdmin(t, srv)
	req, _ := http.NewRequest("GET", srv.URL+"/api/auth/me", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, _ := http.DefaultClient.Do(req)
	var raw bytes.Buffer
	raw.ReadFrom(resp.Body)
	resp.Body.Close()
	if strings.Contains(raw.String(), token) {
		t.Error("the session token was echoed back in the response body")
	}
}

// callArray is for endpoints that return a bare JSON array — the client does
// .map() over these, so an object wrapper would break it.
func callArray(t *testing.T, srv *httptest.Server, method, path, token string) []map[string]any {
	t.Helper()
	req, err := http.NewRequest(method, srv.URL+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out []map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("%s did not return a bare array: %v", path, err)
	}
	return out
}

// CORS is not optional glue: without it every browser request fails at the
// preflight and the app cannot load at all. curl does not enforce CORS, so the
// API passed every command-line check while being unreachable from a browser —
// which is how this was missed until the real UI was pointed at it.
func TestCORSPreflightIsAnswered(t *testing.T) {
	srv, _ := testServer(t)

	req, _ := http.NewRequest("OPTIONS", srv.URL+"/api/auth/status", nil)
	req.Header.Set("Origin", "http://localhost:5173")
	req.Header.Set("Access-Control-Request-Method", "GET")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusNoContent {
		t.Errorf("preflight returned %d, want 204", resp.StatusCode)
	}
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "http://localhost:5173" {
		t.Errorf("Allow-Origin = %q — the browser blocks every request without it", got)
	}
	// The origin is echoed, never "*": wildcard and Allow-Credentials are
	// mutually exclusive per the spec, and the client sends a bearer token.
	if resp.Header.Get("Access-Control-Allow-Origin") == "*" {
		t.Error("Allow-Origin is a wildcard, which is invalid alongside credentials")
	}
	if resp.Header.Get("Access-Control-Allow-Credentials") != "true" {
		t.Error("Allow-Credentials missing")
	}
	if !strings.Contains(resp.Header.Get("Access-Control-Allow-Headers"), "Authorization") {
		t.Error("Authorization is not an allowed header — every authenticated call would fail")
	}
}

func TestCORSRejectsAnUnknownOrigin(t *testing.T) {
	srv, _ := testServer(t)
	req, _ := http.NewRequest("GET", srv.URL+"/api/health", nil)
	req.Header.Set("Origin", "https://evil.example.com")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Error("an unlisted origin was granted CORS access")
	}
}

// Health must actually probe the database. One that answers "ok" without
// touching anything reports healthy while the database is unreachable — exactly
// when someone is reading it.
func TestHealthProbesTheDatabase(t *testing.T) {
	srv, _ := testServer(t)
	_, body := call(t, srv, "GET", "/api/health", "", nil)

	for _, key := range []string{"api", "sqlite", "journal_mode", "db_path", "scheduler", "runtime"} {
		if _, ok := body[key]; !ok {
			t.Errorf("health is missing %q — the frontend and external monitors read these keys", key)
		}
	}
	if body["sqlite"] != "healthy" {
		t.Errorf("sqlite = %v, want \"healthy\"", body["sqlite"])
	}
	if body["journal_mode"] != "wal" {
		t.Errorf("journal_mode = %v, want \"wal\" — concurrent CLI and UI access depends on it", body["journal_mode"])
	}
}
