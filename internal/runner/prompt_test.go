// Tests written before the implementation.
//
// The prompt is what the agent actually receives, so a difference here is a
// behavioural difference in the product, not a formatting detail. Two rules are
// load-bearing and neither is obvious:
//
//  1. The TRIGGER INPUT is never truncated. It is the user's own instruction,
//     and the head of a pasted draft matters more than its tail — truncating it
//     would silently drop the part they cared about most.
//
//  2. Step context IS truncated, to its last 1500 characters. That is the tail
//     on purpose: the most recent output is the relevant background.
package runner

import (
	"strings"
	"testing"

	"github.com/navjyotnishant/specter-agent/internal/graph"
)

func specialist(label, role, objective string) graph.Node {
	return graph.Node{
		ID:   "n1",
		Type: "specialistAgent",
		Data: graph.NodeData{Label: label, Role: role, Objective: objective},
	}
}

func TestSpecialistPromptCarriesRoleAndObjective(t *testing.T) {
	got := BuildPrompt(specialist("Security Reviewer", "security", "check for injection"), "", "")

	for _, want := range []string{
		"You are Security Reviewer, a specialist agent focused on: security.",
		"Objective: check for injection",
		"under 200 words",
		"Respond with a short structured summary only.",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("prompt is missing %q\ngot: %s", want, got)
		}
	}
}

func TestLabelFallsBackToNodeID(t *testing.T) {
	node := graph.Node{ID: "node-7", Type: "specialistAgent"}
	if got := BuildPrompt(node, "", ""); !strings.Contains(got, "You are node-7") {
		t.Errorf("an unlabelled node did not fall back to its id\ngot: %s", got)
	}
}

func TestRoleFallsBackToLabel(t *testing.T) {
	node := specialist("Linter", "", "")
	if got := BuildPrompt(node, "", ""); !strings.Contains(got, "focused on: Linter") {
		t.Errorf("focus did not fall back to the label\ngot: %s", got)
	}
}

func TestTriggerInputIsNeverTruncated(t *testing.T) {
	// The user's own instruction. The head of a pasted draft matters more than
	// its tail, so truncating it drops the part they cared about most.
	long := strings.Repeat("A", 4000) + "THE-IMPORTANT-BIT-AT-THE-END"
	context := TriggerMarker + long

	got := BuildPrompt(specialist("Agent", "role", ""), context, "")
	if !strings.Contains(got, "THE-IMPORTANT-BIT-AT-THE-END") {
		t.Error("the end of the trigger input was truncated")
	}
	if !strings.Contains(got, strings.Repeat("A", 3000)) {
		t.Error("the trigger input was truncated in the middle")
	}
	if !strings.Contains(got, "Treat it as your instruction and act on it directly") {
		t.Error("the trigger input was not framed as a directive")
	}
}

func TestStepContextIsTruncatedToItsTail(t *testing.T) {
	// The opposite rule, on purpose: the most recent output is the relevant
	// background, so the TAIL survives.
	long := "HEAD-SHOULD-BE-CUT" + strings.Repeat("B", 4000) + "TAIL-SHOULD-SURVIVE"
	got := BuildPrompt(specialist("Agent", "role", ""), long, "")

	if !strings.Contains(got, "TAIL-SHOULD-SURVIVE") {
		t.Error("the tail of the step context was dropped — the most recent output is what matters")
	}
	if strings.Contains(got, "HEAD-SHOULD-BE-CUT") {
		t.Error("the step context was not truncated; it must keep only the last 1500 characters")
	}
}

func TestTriggerAndStepContextAreSeparated(t *testing.T) {
	// Both present: the trigger is a directive, the step output is background.
	// Conflating them makes an earlier agent's output read as a user
	// instruction.
	context := TriggerMarker + "review the auth module" + "\n\n" + "previous agent said hello"
	got := BuildPrompt(specialist("Agent", "role", ""), context, "")

	if !strings.Contains(got, "review the auth module") {
		t.Error("the trigger input is missing")
	}
	if !strings.Contains(got, "previous agent said hello") {
		t.Error("the step context is missing")
	}
	directive := strings.Index(got, "Treat it as your instruction")
	background := strings.Index(got, "Previous step context")
	if directive < 0 || background < 0 || directive > background {
		t.Error("the trigger must be framed as a directive BEFORE the background context")
	}
}

func TestContextWithoutTheMarkerIsAllStepContext(t *testing.T) {
	got := BuildPrompt(specialist("Agent", "role", ""), "just some output", "")
	if strings.Contains(got, "Treat it as your instruction") {
		t.Error("context with no trigger marker was treated as a user directive")
	}
	if !strings.Contains(got, "Previous step context") {
		t.Error("unmarked context should be step context")
	}
}

func TestMemoryContextIsBackgroundOnly(t *testing.T) {
	got := BuildPrompt(specialist("Agent", "role", ""), "", "earlier finding")
	if !strings.Contains(got, "earlier finding") {
		t.Error("memory context is missing")
	}
	if !strings.Contains(got, "use as background only") {
		t.Error("memory must be framed as background, not as an instruction")
	}
}

func TestSupervisorPromptDiffersFromSpecialist(t *testing.T) {
	node := graph.Node{ID: "s", Type: "supervisorAgent",
		Data: graph.NodeData{Label: "Lead", Objective: "coordinate"}}
	got := BuildPrompt(node, "", "")

	for _, want := range []string{"a supervisor agent", "3-bullet action plan", "under 300 words"} {
		if !strings.Contains(got, want) {
			t.Errorf("supervisor prompt is missing %q\ngot: %s", want, got)
		}
	}
	if strings.Contains(got, "specialist agent") {
		t.Error("a supervisor was given the specialist preamble")
	}
}

func TestSupervisorWithNoObjectiveGetsADefault(t *testing.T) {
	node := graph.Node{ID: "s", Type: "supervisorAgent", Data: graph.NodeData{Label: "Lead"}}
	if got := BuildPrompt(node, "", ""); !strings.Contains(got, "coordinate the workflow steps that follow") {
		t.Errorf("no default objective for a supervisor\ngot: %s", got)
	}
}
