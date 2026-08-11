package seed

import (
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/navjyotnishant/specter-agent/internal/graph"
	"github.com/navjyotnishant/specter-agent/internal/store"
)

func openStore(t *testing.T) *store.Store {
	t.Helper()
	s, err := store.Open(filepath.Join(t.TempDir(), "app.db"))
	if err != nil {
		t.Fatalf("opening store: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestSeedsAFreshDatabase(t *testing.T) {
	s := openStore(t)

	res, err := Run(s.DB())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Skills == 0 || res.Workflows == 0 {
		t.Fatalf("seeded nothing: %+v", res)
	}

	var skills, templates int
	s.DB().QueryRow("SELECT COUNT(*) FROM skills").Scan(&skills)
	s.DB().QueryRow("SELECT COUNT(*) FROM workflows WHERE is_template = 1").Scan(&templates)
	if skills != res.Skills {
		t.Errorf("reported %d skills, database has %d", res.Skills, skills)
	}
	if templates != res.Workflows {
		t.Errorf("reported %d templates, database has %d", res.Workflows, templates)
	}
}

// A second start must be a no-op. If it were not, every restart would either
// duplicate the library or silently revert whatever the user changed.
func TestSecondRunInsertsNothing(t *testing.T) {
	s := openStore(t)

	first, err := Run(s.DB())
	if err != nil {
		t.Fatalf("first Run: %v", err)
	}
	second, err := Run(s.DB())
	if err != nil {
		t.Fatalf("second Run: %v", err)
	}
	if second.Skills != 0 || second.Workflows != 0 {
		t.Fatalf("second run inserted %+v, want zero", second)
	}

	var skills int
	s.DB().QueryRow("SELECT COUNT(*) FROM skills").Scan(&skills)
	if skills != first.Skills {
		t.Errorf("skill count drifted to %d after a second run, want %d", skills, first.Skills)
	}
}

// The whole point of insert-if-missing: an edited built-in is the user's row now.
func TestUserEditsSurviveRestart(t *testing.T) {
	s := openStore(t)
	if _, err := Run(s.DB()); err != nil {
		t.Fatalf("Run: %v", err)
	}

	const edited = "my own prompt"
	if _, err := s.DB().Exec("UPDATE skills SET prompt_template = ? WHERE id = ?", edited, "secure-code-review"); err != nil {
		t.Fatalf("editing skill: %v", err)
	}

	if _, err := Run(s.DB()); err != nil {
		t.Fatalf("second Run: %v", err)
	}

	var got string
	s.DB().QueryRow("SELECT prompt_template FROM skills WHERE id = ?", "secure-code-review").Scan(&got)
	if got != edited {
		t.Errorf("restart overwrote the user's edit: got %q", got)
	}
}

// Templates must carry is_template=1 — without it they appear as workflows the
// user never created rather than in the gallery.
func TestTemplatesAreFlagged(t *testing.T) {
	s := openStore(t)
	if _, err := Run(s.DB()); err != nil {
		t.Fatalf("Run: %v", err)
	}

	var untagged int
	s.DB().QueryRow("SELECT COUNT(*) FROM workflows WHERE is_template != 1").Scan(&untagged)
	if untagged != 0 {
		t.Errorf("%d seeded workflow(s) are not flagged as templates", untagged)
	}
}

// A template whose graph does not parse is worse than no template: the gallery
// offers it and it fails the moment someone runs it.
func TestSeededGraphsParseAndSchedule(t *testing.T) {
	s := openStore(t)
	if _, err := Run(s.DB()); err != nil {
		t.Fatalf("Run: %v", err)
	}

	rows, err := s.DB().Query("SELECT id, graph_json FROM workflows WHERE is_template = 1")
	if err != nil {
		t.Fatalf("querying templates: %v", err)
	}
	defer rows.Close()

	seen := 0
	for rows.Next() {
		var id, raw string
		if err := rows.Scan(&id, &raw); err != nil {
			t.Fatalf("scan: %v", err)
		}
		seen++

		g, err := graph.Parse([]byte(raw))
		if err != nil {
			t.Errorf("%s: graph_json does not parse: %v", id, err)
			continue
		}
		if len(g.Nodes) == 0 {
			t.Errorf("%s: template has no nodes", id)
		}
		if _, err := g.ExecutionOrder(); err != nil {
			t.Errorf("%s: graph will not schedule: %v", id, err)
		}
	}
	if seen == 0 {
		t.Fatal("no templates to check")
	}
}

// Every skill a template attaches must be a skill that gets seeded. A template
// referencing a slug nobody creates runs with that instruction silently absent.
func TestTemplateSkillReferencesResolve(t *testing.T) {
	var skills []skill
	if err := json.Unmarshal(skillsJSON, &skills); err != nil {
		t.Fatalf("skills.json: %v", err)
	}
	known := map[string]bool{}
	for _, s := range skills {
		known[s.ID] = true
	}

	var workflows []workflow
	if err := json.Unmarshal(workflowsJSON, &workflows); err != nil {
		t.Fatalf("workflows.json: %v", err)
	}
	for _, w := range workflows {
		g, err := graph.Parse(w.Graph)
		if err != nil {
			t.Fatalf("%s: %v", w.ID, err)
		}
		for _, n := range g.Nodes {
			for _, slug := range n.Data.SelectedSkills {
				if !known[slug] {
					t.Errorf("%s node %s references unknown skill %q", w.ID, n.ID, slug)
				}
			}
		}
	}
}

// The ids must match the Python seeder's, or two backends on one database each
// insert their own copy of the same library under different ids.
func TestSkillIDsMatchPython(t *testing.T) {
	want := []string{
		"standard-report-format",
		"secure-code-review",
		"pr-readiness-review",
		"performance-review",
		"dependency-risk-review",
		"secrets-config-review",
		"test-gap-analysis",
		"error-observability-review",
		"release-notes-writer",
		"breaking-change-detector",
		"deployment-risk-assessment",
	}

	var skills []skill
	if err := json.Unmarshal(skillsJSON, &skills); err != nil {
		t.Fatalf("skills.json: %v", err)
	}
	if len(skills) != len(want) {
		t.Fatalf("got %d skills, Python seeds %d", len(skills), len(want))
	}
	for i, id := range want {
		if skills[i].ID != id {
			t.Errorf("skill %d is %q, Python has %q", i, skills[i].ID, id)
		}
		if skills[i].PromptTemplate == "" {
			t.Errorf("%s has an empty prompt template", id)
		}
	}
}
