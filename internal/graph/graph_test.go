package graph

import "testing"

// The graph is authored in the web builder and stored as JSON. The CLI must
// interpret it identically to the Python runner, or the same workflow behaves
// differently depending on which one started it.

const sample = `{
  "nodes": [
    {"id":"a","type":"supervisorAgent","data":{"label":"plan","runtime":"direct","objective":"break it down"}},
    {"id":"b","type":"specialistAgent","data":{"label":"review","runtime":"direct","objective":"review the diff"}},
    {"id":"c","type":"specialistAgent","data":{"label":"tests","objective":"run tests"}}
  ],
  "edges": [
    {"id":"e1","source":"a","target":"b"},
    {"id":"e2","source":"a","target":"c"}
  ]
}`

func TestParse(t *testing.T) {
	g, err := Parse([]byte(sample))
	if err != nil {
		t.Fatal(err)
	}
	if len(g.Nodes) != 3 || len(g.Edges) != 2 {
		t.Fatalf("nodes=%d edges=%d", len(g.Nodes), len(g.Edges))
	}
	if g.Nodes[0].Data.Label != "plan" {
		t.Fatalf("label = %q", g.Nodes[0].Data.Label)
	}
}

// An empty graph is not an error, but running it is: an empty run that reports
// success looks identical to a workflow that did nothing useful.
func TestEmptyGraphIsRejected(t *testing.T) {
	g, err := Parse([]byte(`{"nodes":[],"edges":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := g.ExecutionOrder(); err == nil {
		t.Fatal("an empty graph must not be runnable")
	}
}

// Dependencies decide order: a node runs only once everything feeding it has.
func TestExecutionOrderRespectsDependencies(t *testing.T) {
	g, _ := Parse([]byte(sample))
	order, err := g.ExecutionOrder()
	if err != nil {
		t.Fatal(err)
	}
	if len(order) != 3 {
		t.Fatalf("want 3 nodes, got %d", len(order))
	}

	position := map[string]int{}
	for i, node := range order {
		position[node.ID] = i
	}
	if position["a"] > position["b"] || position["a"] > position["c"] {
		t.Fatalf("the supervisor must run before its targets: %v", position)
	}
}

// A cycle cannot be ordered. Detecting it up front beats discovering it as a
// hang, which is what a naive walk would produce.
func TestCycleIsRejected(t *testing.T) {
	cyclic := `{
      "nodes":[{"id":"a","type":"specialistAgent","data":{}},
               {"id":"b","type":"specialistAgent","data":{}}],
      "edges":[{"id":"1","source":"a","target":"b"},
               {"id":"2","source":"b","target":"a"}]}`

	g, err := Parse([]byte(cyclic))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := g.ExecutionOrder(); err == nil {
		t.Fatal("a cycle must be reported, not walked into")
	}
}

// The runtime field is per-node and optional. The backend's fallback is
// "sandbox"; the builder creates nodes as "direct". Until that inconsistency is
// resolved upstream, the CLI states its own default explicitly rather than
// inheriting an ambiguity.
func TestRuntimeDefaults(t *testing.T) {
	g, _ := Parse([]byte(sample))
	if got := g.Nodes[1].Runtime(); got != "direct" {
		t.Fatalf("explicit runtime = %q, want direct", got)
	}
	if got := g.Nodes[2].Runtime(); got != "direct" {
		t.Fatalf("absent runtime must default to direct, got %q", got)
	}
}

// A node with no objective has nothing to ask the agent. Better to refuse than
// to spawn an agent with an empty prompt and bill for it.
func TestNodesNeedAnObjective(t *testing.T) {
	g, _ := Parse([]byte(`{"nodes":[{"id":"a","type":"specialistAgent","data":{"label":"x"}}],"edges":[]}`))
	if _, err := g.ExecutionOrder(); err == nil {
		t.Fatal("a node with no objective must be reported before the run starts")
	}
}
