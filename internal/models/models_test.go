package models

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A slug carrying two family markers must resolve to the more specific one.
// gpt-5-codex contains both "codex" and "gpt"; calling it GPT is right, but only
// because "codex" is checked first and maps to GPT too. The trap is a future
// entry that reverses this — hence an explicit case.
func TestFamilyPrefersTheMoreSpecificMarker(t *testing.T) {
	for _, c := range []struct{ slug, want string }{
		{"claude-opus-5", "Claude"},
		{"claude-sonnet-5", "Claude"},
		{"gpt-5.3-codex-low", "GPT"},
		{"gpt-5.6-terra", "GPT"},
		{"gemini-2.5-pro", "Gemini"},
		{"composer-1", "Composer"},
		{"auto", "Other"},
		{"something-nobody-has-shipped", "Other"},
	} {
		if got := family(c.slug); got != c.want {
			t.Errorf("family(%q) = %q, want %q", c.slug, got, c.want)
		}
	}
}

// The codex cache is the only source carrying reasoning levels, and a model
// configured with an effort its CLI rejects fails at spawn time rather than at
// configuration time.
func TestCodexCacheIsReadWithItsReasoningLevels(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := os.MkdirAll(filepath.Join(home, ".codex"), 0o755); err != nil {
		t.Fatal(err)
	}
	cache := `{"models":[
	  {"slug":"gpt-5.6-terra","display_name":"GPT-5.6-Terra",
	   "supported_reasoning_levels":[{"effort":"low"},{"effort":"high"}],
	   "default_reasoning_level":"medium"},
	  {"slug":"","display_name":"a row with no slug is skipped"}
	]}`
	if err := os.WriteFile(filepath.Join(home, ".codex", "models_cache.json"), []byte(cache), 0o644); err != nil {
		t.Fatal(err)
	}

	got := fromCodexCache()
	if got.Error != "" {
		t.Fatalf("error: %s", got.Error)
	}
	if len(got.Models) != 1 {
		t.Fatalf("got %d models, want 1 (the slugless row must be skipped)", len(got.Models))
	}
	m := got.Models[0]
	if m.Slug != "gpt-5.6-terra" || m.DefaultEffort != "medium" {
		t.Errorf("model = %+v", m)
	}
	if len(m.Efforts) != 2 {
		t.Errorf("efforts = %v, want both levels", m.Efforts)
	}
}

// A missing cache is a normal state, not a crash — codex has simply never run.
// It must say so rather than reporting an empty catalogue, which reads as "this
// agent has no models".
func TestAMissingCodexCacheExplainsItself(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	got := fromCodexCache()
	if got.Error == "" {
		t.Fatal("a missing cache reported no error, so an empty list looks like a real answer")
	}
	if !strings.Contains(got.Error, "codex") {
		t.Errorf("error does not name the source: %q", got.Error)
	}
}

// Corrupt input must not be reported as "no models". The two states send a user
// to entirely different places.
func TestACorruptCodexCacheIsNotAnEmptyCatalogue(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	os.MkdirAll(filepath.Join(home, ".codex"), 0o755)
	os.WriteFile(filepath.Join(home, ".codex", "models_cache.json"), []byte("{not json"), 0o644)

	got := fromCodexCache()
	if got.Error == "" {
		t.Error("a corrupt cache was reported as an empty model list")
	}
}

// Every agent must be represented even when its CLI is absent, so the caller can
// say WHY a list is empty. Dropping the entry is what made the Models page show
// nothing at all.
func TestEveryAgentIsAccountedForEvenWhenUninstalled(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("PATH", t.TempDir())

	all := All(true)
	if len(all) != len(Agents()) {
		t.Fatalf("got %d entries, want one per agent", len(all))
	}
	for _, a := range all {
		if a.Agent == "" {
			t.Error("an entry does not name its agent")
		}
		if len(a.Models) == 0 && a.Error == "" {
			t.Errorf("%s reported no models and no reason — indistinguishable from a broken probe", a.Agent)
		}
	}
}
