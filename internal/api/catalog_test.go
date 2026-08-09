// Tests for the three catalog routers: agents, connectors, model-providers.
//
// Adjacent routers, two different serialization formats, and the Python source
// is the only contract — both tables are empty in production, so no live data
// pins them:
//
//	agent_definitions.allowed_skill_ids   str(list)    -> "['a', 'b']"  (repr)
//	connectors.config_json                json.dumps() -> {"a":"b"}     (JSON)
//
// Unifying them would be tidier and wrong: a row written by Go and read by
// Python has to round-trip through whatever Python wrote.
//
// The agents router is ALSO the one with no authentication in Python (issue
// #40, 9 open endpoints). This port requires a session, so the tests below
// assert 401 rather than reproducing the gap.
package api

import (
	"net/http"
	"strings"
	"testing"
)

func TestAgentRolesUsePythonRepr(t *testing.T) {
	srv, _ := testServer(t)
	token, _ := bootstrapAdmin(t, srv)

	_, created := call(t, srv, "POST", "/api/agents", token, map[string]any{
		"name": "Reviewer", "role": "reviewer",
		"allowed_skill_ids":     []string{"lint", "sec"},
		"allowed_connector_ids": []string{},
	})
	if got, _ := created["allowed_skill_ids"].(string); got != "['lint', 'sec']" {
		t.Errorf("allowed_skill_ids = %q, want \"['lint', 'sec']\" — Python writes str(list), not JSON", got)
	}
	if got, _ := created["allowed_connector_ids"].(string); got != "[]" {
		t.Errorf("empty connector ids = %q, want \"[]\"", got)
	}
}

func TestAgentCRUD(t *testing.T) {
	srv, _ := testServer(t)
	token, _ := bootstrapAdmin(t, srv)

	code, created := call(t, srv, "POST", "/api/agents", token, map[string]any{
		"name": "Security Reviewer", "role": "reviewer", "description": "checks code",
		"system_instructions": "be careful", "max_iterations": 5,
		"requires_approval_default": true,
	})
	if code != http.StatusOK {
		t.Fatalf("create returned %d", code)
	}
	id, _ := created["id"].(string)
	if id == "" {
		t.Fatal("create returned no id")
	}
	if created["max_iterations"] != float64(5) {
		t.Errorf("max_iterations = %v, want 5", created["max_iterations"])
	}
	if created["requires_approval_default"] != true {
		t.Error("requires_approval_default did not persist as a boolean")
	}
	// Defaults from the Python request model.
	if created["memory_scope_default"] != "workflow" {
		t.Errorf("memory_scope_default = %v, want \"workflow\"", created["memory_scope_default"])
	}

	if code, got := call(t, srv, "GET", "/api/agents/"+id, token, nil); code != http.StatusOK {
		t.Errorf("get returned %d", code)
	} else if got["name"] != "Security Reviewer" {
		t.Errorf("get returned the wrong agent")
	}

	if code, updated := call(t, srv, "PATCH", "/api/agents/"+id, token, map[string]any{
		"name": "Security Reviewer v2", "role": "reviewer",
	}); code != http.StatusOK {
		t.Errorf("update returned %d", code)
	} else if updated["name"] != "Security Reviewer v2" {
		t.Error("the name did not update")
	}

	if code, _ := call(t, srv, "DELETE", "/api/agents/"+id, token, nil); code != http.StatusOK {
		t.Errorf("delete returned %d", code)
	}
	if code, _ := call(t, srv, "GET", "/api/agents/"+id, token, nil); code != http.StatusNotFound {
		t.Errorf("the agent survived deletion (%d)", code)
	}
}

// Issue #40: agents.py has no auth in Python. The port must not reproduce it.
func TestAgentsRequireAuth(t *testing.T) {
	srv, _ := testServer(t)
	bootstrapAdmin(t, srv)
	for _, tc := range []struct{ method, path string }{
		{"GET", "/api/agents"},
		{"POST", "/api/agents"},
		{"GET", "/api/agents/x"},
		{"PATCH", "/api/agents/x"},
		{"DELETE", "/api/agents/x"},
	} {
		if code, _ := call(t, srv, tc.method, tc.path, "", map[string]any{"name": "x", "role": "y"}); code != http.StatusUnauthorized {
			t.Errorf("%s %s returned %d without a token, want 401 (issue #40)", tc.method, tc.path, code)
		}
	}
}

func TestAgentNotFoundIs404(t *testing.T) {
	srv, _ := testServer(t)
	token, _ := bootstrapAdmin(t, srv)
	if code, _ := call(t, srv, "GET", "/api/agents/nope", token, nil); code != http.StatusNotFound {
		t.Errorf("got %d, want 404", code)
	}
	if code, _ := call(t, srv, "PATCH", "/api/agents/nope", token,
		map[string]any{"name": "x", "role": "y"}); code != http.StatusNotFound {
		t.Errorf("patch of a missing agent returned %d, want 404", code)
	}
}

func TestConnectorConfigIsRealJSON(t *testing.T) {
	// Unlike agents, connectors use json.dumps — the two formats genuinely
	// differ and both must be preserved.
	srv, _ := testServer(t)
	token, _ := bootstrapAdmin(t, srv)

	_, created := call(t, srv, "POST", "/api/connectors", token, map[string]any{
		"name": "GitHub", "connector_type": "github",
		"config": map[string]any{"org": "acme"}, "is_configured": true,
	})
	cfg, _ := created["config_json"].(string)
	if !strings.Contains(cfg, `"org"`) {
		t.Errorf("config_json = %q — connectors use json.dumps, so keys are double-quoted", cfg)
	}
	if strings.Contains(cfg, "'org'") {
		t.Errorf("config_json used a Python repr: %q", cfg)
	}
	if created["is_configured"] != true {
		t.Error("is_configured did not persist as a boolean")
	}
}

func TestConnectorCRUD(t *testing.T) {
	srv, _ := testServer(t)
	token, _ := bootstrapAdmin(t, srv)

	code, created := call(t, srv, "POST", "/api/connectors", token, map[string]any{
		"name": "Slack", "connector_type": "slack", "config": map[string]any{},
	})
	if code != http.StatusOK {
		t.Fatalf("create returned %d", code)
	}
	id, _ := created["id"].(string)

	if code, updated := call(t, srv, "PATCH", "/api/connectors/"+id, token, map[string]any{
		"name": "Slack Prod", "connector_type": "slack", "is_configured": true,
	}); code != http.StatusOK {
		t.Errorf("update returned %d", code)
	} else if updated["name"] != "Slack Prod" {
		t.Error("the name did not update")
	}

	if code, _ := call(t, srv, "DELETE", "/api/connectors/"+id, token, nil); code != http.StatusOK {
		t.Errorf("delete returned %d", code)
	}
	if list := callArray(t, srv, "GET", "/api/connectors", token); len(list) != 0 {
		t.Errorf("the connector survived deletion: %d rows", len(list))
	}
}

func TestConnectorNotFoundIs404(t *testing.T) {
	srv, _ := testServer(t)
	token, _ := bootstrapAdmin(t, srv)
	if code, _ := call(t, srv, "PATCH", "/api/connectors/nope", token,
		map[string]any{"name": "x", "connector_type": "y"}); code != http.StatusNotFound {
		t.Errorf("got %d, want 404", code)
	}
}

func TestModelProviderTypeIsValidated(t *testing.T) {
	// Only three types are supported; an unknown one is a 400, not a row that
	// fails later at connect time.
	srv, _ := testServer(t)
	token, _ := bootstrapAdmin(t, srv)

	for _, valid := range []string{"ollama", "openai-compatible", "anthropic-compatible"} {
		if code, _ := call(t, srv, "POST", "/api/model-providers", token, map[string]any{
			"name": "P-" + valid, "provider_type": valid,
		}); code != http.StatusOK {
			t.Errorf("%q was rejected (%d)", valid, code)
		}
	}
	if code, _ := call(t, srv, "POST", "/api/model-providers", token, map[string]any{
		"name": "Bad", "provider_type": "gpt5-turbo-max",
	}); code != http.StatusBadRequest {
		t.Errorf("an unsupported provider type was accepted (%d)", code)
	}
}

func TestModelProviderBaseURLIsValidated(t *testing.T) {
	srv, _ := testServer(t)
	token, _ := bootstrapAdmin(t, srv)

	cases := []struct {
		url  string
		want int
	}{
		{"http://localhost:11434", http.StatusOK},
		{"https://api.example.com", http.StatusOK},
		{"", http.StatusOK},                          // empty becomes null
		{"not-a-url", http.StatusBadRequest},         // no scheme
		{"ftp://example.com", http.StatusBadRequest}, // wrong scheme
		{"http://", http.StatusBadRequest},           // no host
	}
	for i, c := range cases {
		code, _ := call(t, srv, "POST", "/api/model-providers", token, map[string]any{
			"name": "P" + string(rune('a'+i)), "provider_type": "ollama", "base_url": c.url,
		})
		if code != c.want {
			t.Errorf("base_url %q: got %d, want %d", c.url, code, c.want)
		}
	}
}

func TestModelProviderCRUD(t *testing.T) {
	srv, _ := testServer(t)
	token, _ := bootstrapAdmin(t, srv)

	code, created := call(t, srv, "POST", "/api/model-providers", token, map[string]any{
		"name": "Local Ollama", "provider_type": "ollama", "base_url": "http://localhost:11434",
	})
	if code != http.StatusOK {
		t.Fatalf("create returned %d", code)
	}
	id, _ := created["id"].(string)

	if code, updated := call(t, srv, "PATCH", "/api/model-providers/"+id, token, map[string]any{
		"name": "Ollama Prod", "provider_type": "ollama", "is_configured": true,
	}); code != http.StatusOK {
		t.Errorf("update returned %d", code)
	} else if updated["is_configured"] != true {
		t.Error("is_configured did not update")
	}

	if code, _ := call(t, srv, "DELETE", "/api/model-providers/"+id, token, nil); code != http.StatusOK {
		t.Errorf("delete returned %d", code)
	}
	if list := callArray(t, srv, "GET", "/api/model-providers", token); len(list) != 0 {
		t.Errorf("the provider survived deletion: %d rows", len(list))
	}
}

func TestCatalogRoutersRequireAuth(t *testing.T) {
	srv, _ := testServer(t)
	bootstrapAdmin(t, srv)
	for _, path := range []string{"/api/connectors", "/api/model-providers"} {
		if code, _ := call(t, srv, "GET", path, "", nil); code != http.StatusUnauthorized {
			t.Errorf("GET %s without a token returned %d", path, code)
		}
	}
}
