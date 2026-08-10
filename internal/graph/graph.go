// Package graph reads the workflow graph authored in the web builder.
//
// The graph is stored as JSON on the workflow row. The CLI must interpret it the
// same way the Python runner does, or one workflow behaves differently depending
// on which side started it.
package graph

import (
	"encoding/json"
	"fmt"
	"strings"
)

type Graph struct {
	Nodes []Node `json:"nodes"`
	Edges []Edge `json:"edges"`
}

type Node struct {
	ID   string   `json:"id"`
	Type string   `json:"type"`
	Data NodeData `json:"data"`
}

type NodeData struct {
	Label              string   `json:"label"`
	Role               string   `json:"role"`
	Objective          string   `json:"objective"`
	SystemInstructions string   `json:"systemInstructions"`
	Model              string   `json:"model"`
	RuntimeName        string   `json:"runtime"`
	SelectedSkills     []string `json:"selectedSkills"`
	// MemoryScope decides which later nodes see this node's output as
	// background. Empty means "workflow", matching Python's default.
	MemoryScope string `json:"memoryScope"`
	// Scope is the scope a MEMORY NODE announces in its own prompt. Distinct
	// from MemoryScope, which decides where any node's output is stored —
	// Python reads data["scope"] for the prompt and data["memoryScope"] for
	// storage, and conflating them makes every memory node claim "workflow
	// scope" regardless of how it was configured.
	Scope string `json:"scope"`
	// FieldName names the run-input key a trigger node reads.
	FieldName string `json:"fieldName"`
	// DelegationStrategy on a supervisor decides whether a level runs its nodes
	// concurrently.
	DelegationStrategy string `json:"delegationStrategy"`
	// SandboxAgent names the agent CLI — claude, codex, cursor, gemini. This is
	// NOT the runtime: Runtime() says WHERE the agent runs (direct or sandbox),
	// this says WHICH agent runs.
	SandboxAgent string `json:"sandboxAgent"`
	// Agent is the older key for the same thing; Python reads both.
	Agent string `json:"agent"`
	// Condition is the yes/no question a conditional node asks.
	Condition string `json:"condition"`
	// URL, Method and PayloadTemplate configure a webhook node.
	URL             string `json:"url"`
	Method          string `json:"method"`
	PayloadTemplate string `json:"payloadTemplate"`
}

type Edge struct {
	ID     string `json:"id"`
	Source string `json:"source"`
	Target string `json:"target"`
}

// Runtime is the node's execution runtime.
//
// Defaults to "direct" when absent. The field is optional and the two existing
// implementations disagree — the web builder creates nodes as "direct" while the
// Python backend falls back to "sandbox", so a node saved before the field
// existed runs in the opposite runtime from a new one. Stating the default here
// explicitly beats inheriting that ambiguity silently.
func (n Node) Runtime() string {
	if strings.TrimSpace(n.Data.RuntimeName) == "" {
		return "direct"
	}
	return n.Data.RuntimeName
}

// Name is what to show for this node — its label, or its id when unlabelled.
// AgentName is which agent CLI to spawn, defaulting to claude — matching
// Python's `data.get("sandboxAgent") or data.get("agent") or "claude"`.
//
// Distinct from Runtime(), which says WHERE the agent runs. Passing a runtime
// mode to CLI resolution looks for a binary named "direct" and reports "no agent
// CLI found", which is a confusing way to say the wrong field was read.
func (n Node) AgentName() string {
	if agent := strings.TrimSpace(n.Data.SandboxAgent); agent != "" {
		return strings.ToLower(agent)
	}
	if agent := strings.TrimSpace(n.Data.Agent); agent != "" {
		return strings.ToLower(agent)
	}
	return "claude"
}

func (n Node) Name() string {
	if label := strings.TrimSpace(n.Data.Label); label != "" {
		return label
	}
	return n.ID
}

func Parse(raw []byte) (*Graph, error) {
	var g Graph
	if err := json.Unmarshal(raw, &g); err != nil {
		return nil, fmt.Errorf("parsing workflow graph: %w", err)
	}
	return &g, nil
}

// ExecutionOrder returns nodes in dependency order: a node appears only after
// everything feeding it.
//
// Kahn's algorithm, which detects a cycle rather than walking into one. A naive
// walk would hang instead, and a hang is far harder to diagnose than a message.
//
// Validation happens here rather than mid-run so a broken graph fails before an
// agent is spawned and billed for.
func (g *Graph) ExecutionOrder() ([]Node, error) {
	if len(g.Nodes) == 0 {
		return nil, fmt.Errorf("this workflow has no nodes")
	}

	byID := make(map[string]Node, len(g.Nodes))
	indegree := make(map[string]int, len(g.Nodes))
	for _, node := range g.Nodes {
		byID[node.ID] = node
		indegree[node.ID] = 0
	}

	// A node with nothing to ask the agent cannot run. Refusing beats spawning
	// an agent with an empty prompt.
	for _, node := range g.Nodes {
		if strings.TrimSpace(node.Data.Objective) == "" {
			return nil, fmt.Errorf("node %q has no objective set", node.Name())
		}
	}

	dependents := make(map[string][]string, len(g.Edges))
	for _, edge := range g.Edges {
		if _, ok := byID[edge.Source]; !ok {
			return nil, fmt.Errorf("edge %q points from an unknown node %q", edge.ID, edge.Source)
		}
		if _, ok := byID[edge.Target]; !ok {
			return nil, fmt.Errorf("edge %q points to an unknown node %q", edge.ID, edge.Target)
		}
		dependents[edge.Source] = append(dependents[edge.Source], edge.Target)
		indegree[edge.Target]++
	}

	// Seeded in declaration order so a graph with several roots runs in the
	// order the author laid it out, rather than Go's random map order.
	var ready []string
	for _, node := range g.Nodes {
		if indegree[node.ID] == 0 {
			ready = append(ready, node.ID)
		}
	}

	var order []Node
	for len(ready) > 0 {
		id := ready[0]
		ready = ready[1:]
		order = append(order, byID[id])

		for _, next := range dependents[id] {
			indegree[next]--
			if indegree[next] == 0 {
				ready = append(ready, next)
			}
		}
	}

	if len(order) != len(g.Nodes) {
		return nil, fmt.Errorf(
			"this workflow has a cycle: %d of %d nodes can never run",
			len(g.Nodes)-len(order), len(g.Nodes))
	}
	return order, nil
}
