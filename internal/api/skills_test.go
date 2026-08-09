// Tests written before the handlers.
//
// The sharp edge here is compatible_agent_roles. Python writes str(list) — a
// Python REPR with single quotes, not JSON:
//
//	"['Codex CLI', 'read-only', 'selected repository']"
//
// and src/lib/types.ts types the field as `string`, so the UI renders it
// verbatim and never parses it. A Go port that emitted proper JSON would
// silently change what every existing skill displays, and nothing would fail.
package api

import (
	"net/http"
	"strings"
	"testing"
)

func TestSkillRolesKeepPythonsReprFormat(t *testing.T) {
	srv, _ := testServer(t)
	token, _ := bootstrapAdmin(t, srv)

	_, created := call(t, srv, "POST", "/api/skills", token, map[string]any{
		"name":                   "Secure Review",
		"compatible_agent_roles": []string{"Codex CLI", "read-only"},
	})
	roles, _ := created["compatible_agent_roles"].(string)
	if roles != "['Codex CLI', 'read-only']" {
		t.Errorf("roles = %q\nwant   \"['Codex CLI', 'read-only']\"\n"+
			"the UI renders this string verbatim, so JSON quoting would change what every skill displays", roles)
	}
	if strings.Contains(roles, `"`) {
		t.Error("roles use JSON double quotes — Python writes a repr with single quotes")
	}
}

func TestEmptyRolesAreAnEmptyList(t *testing.T) {
	srv, _ := testServer(t)
	token, _ := bootstrapAdmin(t, srv)
	_, created := call(t, srv, "POST", "/api/skills", token, map[string]any{"name": "No Roles"})
	if got := created["compatible_agent_roles"]; got != "[]" {
		t.Errorf("roles = %q, want \"[]\"", got)
	}
}

func TestSkillCRUD(t *testing.T) {
	srv, _ := testServer(t)
	token, _ := bootstrapAdmin(t, srv)

	code, created := call(t, srv, "POST", "/api/skills", token, map[string]any{
		"name": "Code Review", "description": "reviews", "prompt_template": "do it",
		"source_repo": "github.com/x/y",
	})
	if code != http.StatusOK {
		t.Fatalf("create returned %d", code)
	}
	id, _ := created["id"].(string)
	if id == "" {
		t.Fatal("create returned no id")
	}

	if code, got := call(t, srv, "GET", "/api/skills/"+id, token, nil); code != http.StatusOK {
		t.Errorf("get returned %d", code)
	} else if got["name"] != "Code Review" || got["source_repo"] != "github.com/x/y" {
		t.Errorf("get returned the wrong skill: %+v", got)
	}

	if code, updated := call(t, srv, "PATCH", "/api/skills/"+id, token, map[string]any{
		"name": "Code Review v2",
	}); code != http.StatusOK {
		t.Errorf("update returned %d", code)
	} else if updated["name"] != "Code Review v2" {
		t.Error("the name did not update")
	}

	if code, _ := call(t, srv, "DELETE", "/api/skills/"+id, token, nil); code != http.StatusOK {
		t.Errorf("delete returned %d", code)
	}
	if code, _ := call(t, srv, "GET", "/api/skills/"+id, token, nil); code != http.StatusNotFound {
		t.Errorf("the skill survived deletion (%d)", code)
	}
}

func TestSkillIDMayBeASlugForRepoImport(t *testing.T) {
	// A repo import supplies a slug so an imported skill resolves by the same
	// key the source repo uses.
	srv, _ := testServer(t)
	token, _ := bootstrapAdmin(t, srv)

	_, created := call(t, srv, "POST", "/api/skills", token,
		map[string]any{"id": "secure-code-review", "name": "Secure Code Review"})
	if created["id"] != "secure-code-review" {
		t.Errorf("the supplied id was ignored: %+v", created["id"])
	}
}

func TestReimportingASkillRequiresUpsert(t *testing.T) {
	srv, _ := testServer(t)
	token, _ := bootstrapAdmin(t, srv)

	body := map[string]any{"id": "my-skill", "name": "Mine"}
	if code, _ := call(t, srv, "POST", "/api/skills", token, body); code != http.StatusOK {
		t.Fatal("the first import failed")
	}
	// Same id, no upsert -> conflict rather than a silent overwrite.
	if code, _ := call(t, srv, "POST", "/api/skills", token,
		map[string]any{"id": "my-skill", "name": "Mine Again"}); code != http.StatusConflict {
		t.Errorf("re-import without upsert returned %d, want 409", code)
	}
	// With upsert -> updates in place instead of duplicating.
	code, updated := call(t, srv, "POST", "/api/skills", token,
		map[string]any{"id": "my-skill", "name": "Mine Updated", "upsert": true})
	if code != http.StatusOK {
		t.Fatalf("upsert returned %d", code)
	}
	if updated["name"] != "Mine Updated" {
		t.Error("upsert did not update the row")
	}
	list := callArray(t, srv, "GET", "/api/skills", token)
	if len(list) != 1 {
		t.Errorf("upsert duplicated the skill: %d rows", len(list))
	}
}

func TestSkillNamesAreUniqueCaseInsensitively(t *testing.T) {
	// Names are how a skill is picked in the builder, so two called the same
	// thing are indistinguishable there.
	srv, _ := testServer(t)
	token, _ := bootstrapAdmin(t, srv)

	call(t, srv, "POST", "/api/skills", token, map[string]any{"name": "Lint"})
	for _, name := range []string{"Lint", "lint", "LINT", "  Lint  "} {
		if code, _ := call(t, srv, "POST", "/api/skills", token,
			map[string]any{"name": name}); code != http.StatusConflict {
			t.Errorf("%q was accepted (%d)", name, code)
		}
	}
}

func TestSkillsRequireAuth(t *testing.T) {
	srv, _ := testServer(t)
	bootstrapAdmin(t, srv)
	if code, _ := call(t, srv, "GET", "/api/skills", "", nil); code != http.StatusUnauthorized {
		t.Errorf("listing skills without a token returned %d", code)
	}
}
