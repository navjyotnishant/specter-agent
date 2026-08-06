package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/navjyotnishant/specter-agent/internal/store"
)

// Asserts the exact response SHAPES src/lib/api.ts declares. A handler can pass
// every behavioural test and still return {"data":{...}} instead of {"user":...},
// which breaks the frontend at runtime with a green test suite.
func jsonBody(s string) *strings.Reader { return strings.NewReader(s) }

func TestResponseShapesMatchTheTypeScriptClient(t *testing.T) {
	s, _ := store.Open(t.TempDir() + "/app.db")
	defer s.Close()
	srv := httptest.NewServer(NewRouter(&Deps{Store: s}))
	defer srv.Close()

	get := func(method, path, token string, body string) map[string]any {
		var r *http.Request
		if body != "" {
			r, _ = http.NewRequest(method, srv.URL+path, jsonBody(body))
		} else {
			r, _ = http.NewRequest(method, srv.URL+path, nil)
		}
		r.Header.Set("Content-Type", "application/json")
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		resp, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var out map[string]any
		json.NewDecoder(resp.Body).Decode(&out)
		return out
	}

	// authStatus: { needs_setup: boolean }
	if v, ok := get("GET", "/api/auth/status", "", "")["needs_setup"].(bool); !ok {
		t.Error("needs_setup is not a boolean")
	} else {
		t.Logf("  authStatus  { needs_setup: %v }", v)
	}

	// bootstrap: { user: AuthUser }
	b := get("POST", "/api/auth/bootstrap", "", `{"email":"a@b.co","password":"hunter2hunter2"}`)
	if _, ok := b["user"].(map[string]any); !ok {
		t.Errorf("bootstrap did not return { user }: %+v", b)
	} else {
		t.Log("  bootstrap   { user }")
	}

	// login: { user: AuthUser, token: string }
	l := get("POST", "/api/auth/login", "", `{"email":"a@b.co","password":"hunter2hunter2"}`)
	token, hasToken := l["token"].(string)
	user, hasUser := l["user"].(map[string]any)
	if !hasToken || !hasUser {
		t.Fatalf("login did not return { user, token }: %+v", l)
	}
	for _, field := range []string{"id", "email", "role", "created_at"} {
		if _, ok := user[field]; !ok {
			t.Errorf("AuthUser is missing %q", field)
		}
	}
	t.Log("  login       { user{id,email,role,created_at}, token }")

	// me: { user: AuthUser }
	if _, ok := get("GET", "/api/auth/me", token, "")["user"]; !ok {
		t.Error("me did not return { user }")
	} else {
		t.Log("  me          { user }")
	}

	// users: AuthUser[] — a bare ARRAY, not { users: [...] }
	req, _ := http.NewRequest("GET", srv.URL+"/api/auth/users", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, _ := http.DefaultClient.Do(req)
	var list []map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&list); err != nil {
		t.Errorf("users is not a bare array — the client does users.map(): %v", err)
	} else {
		t.Logf("  users       AuthUser[] (%d)", len(list))
	}
	resp.Body.Close()

	// logout: { ok: boolean }
	if _, ok := get("POST", "/api/auth/logout", token, "")["ok"].(bool); !ok {
		t.Error("logout did not return { ok: boolean }")
	} else {
		t.Log("  logout      { ok }")
	}

	// the error shape formatErrorMessage() parses: { detail: string }
	e := get("GET", "/api/auth/me", "bad-token", "")
	if _, ok := e["detail"].(string); !ok {
		t.Errorf("errors do not use { detail: string } — the UI shows 'Request failed: 401': %+v", e)
	} else {
		t.Logf("  error       { detail: %q }", e["detail"])
	}
}
