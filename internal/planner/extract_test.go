// Extracting a plan from an agent's reply.
//
// Every branch here exists because a model actually produced that output. An
// agent asked for JSON returns JSON *somewhere*: inside a fence, after a
// paragraph of preamble, or with a brace missing. The alternative to repairing
// is failing a workflow build on output that is almost right.
//
// The rule that matters: prefer the LAST fenced block. CLI output routinely
// prepends sandbox and bootstrap noise — sometimes containing its own JSON —
// before the agent's real answer.
package planner

import (
	"strings"
	"testing"
)

func TestPlainJSONIsParsed(t *testing.T) {
	plan, err := ExtractPlan(`{"subtasks":[{"id":"a","label":"Review"}]}`)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Subtasks) != 1 || plan.Subtasks[0].ID != "a" {
		t.Errorf("plan = %+v", plan)
	}
}

func TestTheLastFencedBlockWins(t *testing.T) {
	// Taking the first fence returns the sandbox's bootstrap chatter as a plan.
	reply := "```json\n{\"subtasks\":[{\"id\":\"noise\",\"label\":\"Bootstrap\"}]}\n```\n" +
		"Now the actual plan:\n" +
		"```json\n{\"subtasks\":[{\"id\":\"real\",\"label\":\"Review auth\"}]}\n```"

	plan, err := ExtractPlan(reply)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Subtasks[0].ID != "real" {
		t.Errorf("took the first fence, not the last: %+v", plan.Subtasks)
	}
}

func TestJSONAfterProseIsFound(t *testing.T) {
	reply := `I looked at the repository and here is my plan.

{"subtasks":[{"id":"a","label":"Check the auth module"}]}

Let me know if you want changes.`

	plan, err := ExtractPlan(reply)
	if err != nil {
		t.Fatalf("prose around the JSON defeated extraction: %v", err)
	}
	if plan.Subtasks[0].Label != "Check the auth module" {
		t.Errorf("plan = %+v", plan)
	}
}

func TestAnObjectWithoutSubtasksIsNotAPlan(t *testing.T) {
	// A balanced {...} is not enough: accepting the first brace pair returns
	// whatever object appeared first in the agent's reasoning.
	reply := `{"thinking": "let me consider this"}
{"subtasks":[{"id":"a","label":"Real"}]}`

	plan, err := ExtractPlan(reply)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Subtasks) != 1 || plan.Subtasks[0].ID != "a" {
		t.Errorf("picked the wrong object: %+v", plan)
	}
}

func TestAMissingOuterBraceIsRepaired(t *testing.T) {
	// Models drop the closing brace on long output often enough to matter.
	plan, err := ExtractPlan(`{"subtasks":[{"id":"a","label":"Review"}]`)
	if err != nil {
		t.Fatalf("a missing closing brace was not repaired: %v", err)
	}
	if len(plan.Subtasks) != 1 {
		t.Errorf("plan = %+v", plan)
	}
}

func TestNothingResemblingAPlanIsAnError(t *testing.T) {
	// Repair has a limit. Inventing a plan from an agent that did not produce
	// one would build a workflow nobody asked for.
	for _, reply := range []string{
		"", "I could not complete this task.",
		"```json\n{\"error\":\"quota exceeded\"}\n```",
	} {
		if _, err := ExtractPlan(reply); err == nil {
			t.Errorf("accepted a reply containing no plan: %q", reply)
		}
	}
}

func TestValidationRejectsAnEmptyPlan(t *testing.T) {
	if _, err := ExtractPlan(`{"subtasks":[]}`); err == nil {
		t.Error("an empty subtask list was accepted — that builds a workflow with no work in it")
	}
}

func TestValidationRejectsDuplicateIDs(t *testing.T) {
	// Node ids become graph ids; duplicates make edges ambiguous.
	_, err := ExtractPlan(`{"subtasks":[{"id":"a","label":"One"},{"id":"a","label":"Two"}]}`)
	if err == nil {
		t.Fatal("duplicate subtask ids were accepted")
	}
	if !strings.Contains(strings.ToLower(err.Error()), "duplicate") {
		t.Errorf("error does not explain the problem: %v", err)
	}
}

func TestValidationRequiresIDAndLabel(t *testing.T) {
	for _, body := range []string{
		`{"subtasks":[{"label":"No id"}]}`,
		`{"subtasks":[{"id":"a"}]}`,
		`{"subtasks":[{"id":"  ","label":"Blank id"}]}`,
	} {
		if _, err := ExtractPlan(body); err == nil {
			t.Errorf("accepted an incomplete subtask: %s", body)
		}
	}
}

func TestAnAbsurdlyLargePlanIsRejected(t *testing.T) {
	// A model that loops produces hundreds of subtasks, and rendering them is a
	// canvas nobody can use.
	var subtasks []string
	for i := 0; i < 100; i++ {
		subtasks = append(subtasks,
			`{"id":"n`+string(rune('a'+i%26))+string(rune('a'+i/26))+`","label":"x"}`)
	}
	if _, err := ExtractPlan(`{"subtasks":[` + strings.Join(subtasks, ",") + `]}`); err == nil {
		t.Error("a 100-subtask plan was accepted")
	}
}

func TestPlanBecomesAGraphWiredToTheSupervisor(t *testing.T) {
	plan, err := ExtractPlan(`{"subtasks":[
	  {"id":"a","label":"Scan","role":"security","objective":"look for issues"},
	  {"id":"b","label":"Report","dependsOn":["a"]}
	]}`)
	if err != nil {
		t.Fatal(err)
	}

	graph := PlanToGraph(plan, "supervisor-1", "direct", "claude")
	if len(graph.Nodes) != 2 {
		t.Fatalf("got %d nodes, want 2", len(graph.Nodes))
	}
	for _, node := range graph.Nodes {
		if node.Type != "specialistAgent" {
			t.Errorf("node %s has type %q", node.ID, node.Type)
		}
	}

	// A subtask with no declared dependency hangs off the SUPERVISOR. Without
	// that edge it is unreachable and never runs.
	var fromSupervisor, declared int
	for _, edge := range graph.Edges {
		if edge.Source == "supervisor-1" {
			fromSupervisor++
		} else {
			declared++
		}
	}
	if fromSupervisor != 1 {
		t.Errorf("%d edges from the supervisor, want 1", fromSupervisor)
	}
	if declared != 1 {
		t.Errorf("%d dependency edges, want 1", declared)
	}
}

func TestAPlanNodeCarriesItsRuntimeAndAgent(t *testing.T) {
	// A generated node that ignored the chosen agent would silently run on
	// whatever the default is.
	plan, _ := ExtractPlan(`{"subtasks":[{"id":"a","label":"Scan"}]}`)
	graph := PlanToGraph(plan, "sup", "sandbox", "codex")

	if graph.Nodes[0].Data.RuntimeName != "sandbox" {
		t.Errorf("runtime = %q", graph.Nodes[0].Data.RuntimeName)
	}
	if graph.Nodes[0].Data.SandboxAgent != "codex" {
		t.Errorf("agent = %q", graph.Nodes[0].Data.SandboxAgent)
	}
}

func TestADependencyOnAnUnknownIDIsDropped(t *testing.T) {
	// An edge to a node that does not exist makes the graph unschedulable, and
	// models do hallucinate ids.
	plan, err := ExtractPlan(`{"subtasks":[{"id":"a","label":"One","dependsOn":["ghost"]}]}`)
	if err != nil {
		t.Fatal(err)
	}
	graph := PlanToGraph(plan, "sup", "direct", "claude")
	for _, edge := range graph.Edges {
		if edge.Source == "ghost" || edge.Target == "ghost" {
			t.Error("an edge references a subtask that does not exist")
		}
	}
	// Losing its only dependency makes it a root, so it must hang off the
	// supervisor rather than becoming unreachable.
	if len(graph.Edges) != 1 || graph.Edges[0].Source != "sup" {
		t.Errorf("edges = %+v", graph.Edges)
	}
}

// The planning prompt asks for depends_on; models answer with that. Reading
// only dependsOn drops EVERY dependency, and the result still runs — as a flat
// graph where nothing waits for anything, which looks like a plan that simply
// had no ordering. Nothing fails, and the workflow is wrong.
func TestBothDependencySpellingsAreRead(t *testing.T) {
	for _, key := range []string{"depends_on", "dependsOn"} {
		t.Run(key, func(t *testing.T) {
			plan, err := ExtractPlan(`{"subtasks":[
			  {"id":"a","label":"First"},
			  {"id":"b","label":"Second","` + key + `":["a"]}
			]}`)
			if err != nil {
				t.Fatal(err)
			}
			g := PlanToGraph(plan, "sup", "direct", "claude")

			var dependency bool
			for _, edge := range g.Edges {
				if edge.Source == "a" && edge.Target == "b" {
					dependency = true
				}
			}
			if !dependency {
				t.Errorf("%q was ignored — b would run beside a instead of after it: %+v", key, g.Edges)
			}
		})
	}
}
