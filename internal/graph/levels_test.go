// Tests written before the implementation.
//
// Levels are what the runner schedules against: nodes in one level have no
// dependency between them and run in parallel. Two rules matter more than the
// topology itself.
//
//  1. A humanApproval node gets a LEVEL OF ITS OWN. An approval that ran
//     alongside three agents would gate nothing — the actions it exists to
//     authorise would already be in flight.
//
//  2. Levels are LENIENT where the CLI's ExecutionOrder is strict. Python's
//     runner never raises on a cycle: Kahn drops the cycled nodes and a fallback
//     appends them at the end, so a malformed graph still runs rather than
//     refusing to start. ExecutionOrder rejects the same graph, because a CLI
//     run has a human watching who can fix it. Both behaviours are deliberate
//     and both are pinned here.
package graph

import (
	"testing"
)

func nodes(specs ...[2]string) []Node {
	out := make([]Node, 0, len(specs))
	for _, s := range specs {
		out = append(out, Node{ID: s[0], Type: s[1], Data: NodeData{Objective: "do the thing"}})
	}
	return out
}

func edges(pairs ...[2]string) []Edge {
	out := make([]Edge, 0, len(pairs))
	for i, p := range pairs {
		out = append(out, Edge{ID: string(rune('a' + i)), Source: p[0], Target: p[1]})
	}
	return out
}

// levelIDs flattens levels to ids for comparison.
func levelIDs(levels [][]Node) [][]string {
	out := make([][]string, len(levels))
	for i, level := range levels {
		for _, n := range level {
			out[i] = append(out[i], n.ID)
		}
	}
	return out
}

func equal(a, b [][]string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if len(a[i]) != len(b[i]) {
			return false
		}
		for j := range a[i] {
			if a[i][j] != b[i][j] {
				return false
			}
		}
	}
	return true
}

func TestSiblingsShareALevel(t *testing.T) {
	// a -> b, a -> c : b and c are independent and run together.
	g := &Graph{
		Nodes: nodes([2]string{"a", "specialistAgent"}, [2]string{"b", "specialistAgent"}, [2]string{"c", "specialistAgent"}),
		Edges: edges([2]string{"a", "b"}, [2]string{"a", "c"}),
	}
	got := levelIDs(g.Levels())
	want := [][]string{{"a"}, {"b", "c"}}
	if !equal(got, want) {
		t.Errorf("levels = %v, want %v", got, want)
	}
}

func TestDepthIsMaxParentDepthPlusOne(t *testing.T) {
	// a -> b -> d, a -> c -> d : d waits for BOTH branches, so it is depth 2,
	// not depth 1 via the shorter path.
	g := &Graph{
		Nodes: nodes([2]string{"a", "specialistAgent"}, [2]string{"b", "specialistAgent"},
			[2]string{"c", "specialistAgent"}, [2]string{"d", "specialistAgent"}),
		Edges: edges([2]string{"a", "b"}, [2]string{"a", "c"}, [2]string{"b", "d"}, [2]string{"c", "d"}),
	}
	got := levelIDs(g.Levels())
	want := [][]string{{"a"}, {"b", "c"}, {"d"}}
	if !equal(got, want) {
		t.Errorf("levels = %v, want %v — d must wait for both parents", got, want)
	}
}

func TestApprovalGetsItsOwnLevel(t *testing.T) {
	// The rule that makes the gate mean anything. Without it the approval sits
	// beside b and c and the agents run while a human is still deciding.
	g := &Graph{
		Nodes: nodes([2]string{"a", "specialistAgent"}, [2]string{"b", "specialistAgent"},
			[2]string{"gate", "humanApproval"}, [2]string{"c", "specialistAgent"}),
		Edges: edges([2]string{"a", "b"}, [2]string{"a", "gate"}, [2]string{"a", "c"}),
	}
	got := levelIDs(g.Levels())
	want := [][]string{{"a"}, {"b", "c"}, {"gate"}}
	if !equal(got, want) {
		t.Errorf("levels = %v, want %v — the gate must not share a level with agents", got, want)
	}
}

func TestTwoApprovalsInOneDepthBecomeTwoLevels(t *testing.T) {
	// Each gate is resolved on its own; batching them would let one approval
	// implicitly authorise the other.
	g := &Graph{
		Nodes: nodes([2]string{"a", "specialistAgent"},
			[2]string{"g1", "humanApproval"}, [2]string{"g2", "humanApproval"}),
		Edges: edges([2]string{"a", "g1"}, [2]string{"a", "g2"}),
	}
	got := levelIDs(g.Levels())
	want := [][]string{{"a"}, {"g1"}, {"g2"}}
	if !equal(got, want) {
		t.Errorf("levels = %v, want %v — each gate is its own level", got, want)
	}
}

func TestAnApprovalOnlyLevelProducesNoEmptyLevel(t *testing.T) {
	// A level containing only approvals must not also emit an empty agent
	// level; the runner would iterate over nothing and log a phantom step.
	g := &Graph{
		Nodes: nodes([2]string{"a", "specialistAgent"}, [2]string{"gate", "humanApproval"}),
		Edges: edges([2]string{"a", "gate"}),
	}
	for i, level := range g.Levels() {
		if len(level) == 0 {
			t.Errorf("level %d is empty", i)
		}
	}
}

func TestDisconnectedNodesStillRun(t *testing.T) {
	// A node with no edges is a root: it has nothing to wait for.
	g := &Graph{
		Nodes: nodes([2]string{"a", "specialistAgent"}, [2]string{"lonely", "specialistAgent"}),
		Edges: nil,
	}
	got := levelIDs(g.Levels())
	want := [][]string{{"a", "lonely"}}
	if !equal(got, want) {
		t.Errorf("levels = %v, want %v", got, want)
	}
}

func TestACycleDegradesRatherThanRefusing(t *testing.T) {
	// Python's runner never raises on a cycle: Kahn drops the cycled nodes and
	// the fallback appends them, so the run proceeds. Refusing here would make
	// the Go backend reject a graph the Python one accepts, and a workflow would
	// behave differently depending on which side started it.
	//
	// ExecutionOrder (the CLI path) DOES reject it — see the test below.
	g := &Graph{
		Nodes: nodes([2]string{"a", "specialistAgent"}, [2]string{"b", "specialistAgent"},
			[2]string{"c", "specialistAgent"}),
		Edges: edges([2]string{"a", "b"}, [2]string{"b", "c"}, [2]string{"c", "b"}),
	}
	levels := g.Levels()
	seen := map[string]bool{}
	for _, level := range levels {
		for _, n := range level {
			if seen[n.ID] {
				t.Errorf("node %q appears twice", n.ID)
			}
			seen[n.ID] = true
		}
	}
	for _, id := range []string{"a", "b", "c"} {
		if !seen[id] {
			t.Errorf("node %q was dropped — a cycle must degrade, not lose nodes", id)
		}
	}
}

func TestExecutionOrderStillRejectsACycle(t *testing.T) {
	// The CLI path stays strict. A human is watching and can fix the graph, so
	// refusing beats running a workflow whose shape is wrong.
	g := &Graph{
		Nodes: nodes([2]string{"a", "specialistAgent"}, [2]string{"b", "specialistAgent"}),
		Edges: edges([2]string{"a", "b"}, [2]string{"b", "a"}),
	}
	if _, err := g.ExecutionOrder(); err == nil {
		t.Error("ExecutionOrder accepted a cycle; the CLI path must refuse it")
	}
}

func TestEmptyGraphHasNoLevels(t *testing.T) {
	g := &Graph{}
	if levels := g.Levels(); len(levels) != 0 {
		t.Errorf("an empty graph produced %d levels", len(levels))
	}
}

func TestEdgesToUnknownNodesAreIgnored(t *testing.T) {
	// Python checks membership before wiring an edge, so a dangling edge is
	// skipped rather than raising. A saved graph can reference a node the user
	// has since deleted.
	g := &Graph{
		Nodes: nodes([2]string{"a", "specialistAgent"}, [2]string{"b", "specialistAgent"}),
		Edges: edges([2]string{"a", "b"}, [2]string{"a", "ghost"}, [2]string{"ghost", "b"}),
	}
	got := levelIDs(g.Levels())
	want := [][]string{{"a"}, {"b"}}
	if !equal(got, want) {
		t.Errorf("levels = %v, want %v — a dangling edge must not change scheduling", got, want)
	}
}

func TestDeclarationOrderIsPreservedWithinALevel(t *testing.T) {
	// Go map iteration is random. Without an explicit ordering the same graph
	// would schedule differently between runs, which makes a failure impossible
	// to reproduce.
	g := &Graph{
		Nodes: nodes([2]string{"root", "specialistAgent"}, [2]string{"z", "specialistAgent"},
			[2]string{"m", "specialistAgent"}, [2]string{"a", "specialistAgent"}),
		Edges: edges([2]string{"root", "z"}, [2]string{"root", "m"}, [2]string{"root", "a"}),
	}
	for i := 0; i < 20; i++ {
		got := levelIDs(g.Levels())
		want := [][]string{{"root"}, {"z", "m", "a"}}
		if !equal(got, want) {
			t.Fatalf("run %d: levels = %v, want %v — scheduling must be deterministic", i, got, want)
		}
	}
}
