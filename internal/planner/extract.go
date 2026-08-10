// Package planner turns an objective into a workflow subgraph by asking an
// agent, then repairing and validating what it says.
package planner

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/navjyotnishant/specter-agent/internal/graph"
)

// MaxSubtasks bounds a plan. A model that loops produces hundreds, and a canvas
// with hundreds of nodes is one nobody can use.
const MaxSubtasks = 10

type Subtask struct {
	ID                 string `json:"id"`
	Label              string `json:"label"`
	Role               string `json:"role"`
	Objective          string `json:"objective"`
	SystemInstructions string `json:"systemInstructions"`
	// The planning prompt asks for depends_on, and that is what models return.
	// Reading only dependsOn drops EVERY dependency, and the result still runs
	// — as a flat graph where nothing waits for anything, which looks like a
	// plan that simply had no ordering.
	DependsOn      []string `json:"depends_on"`
	DependsOnCamel []string `json:"dependsOn"`
}

// dependencies merges both spellings. The prompt asks for depends_on; a model
// that answers in camelCase is still answering correctly.
func (s Subtask) dependencies() []string {
	if len(s.DependsOn) > 0 {
		return s.DependsOn
	}
	return s.DependsOnCamel
}

type Plan struct {
	Subtasks []Subtask `json:"subtasks"`
}

var fencePattern = regexp.MustCompile("(?s)```(?:json)?\\s*(.*?)```")

// ExtractPlan finds a plan in an agent's reply and validates it.
//
// The repair steps are not defensive programming for its own sake — each one
// corresponds to output a model actually produced. The alternative is failing a
// workflow build on a reply that is almost right.
func ExtractPlan(reply string) (Plan, error) {
	raw := strings.TrimSpace(reply)
	if raw == "" {
		return Plan{}, errors.New("the planner returned nothing")
	}

	var candidates []string
	// The LAST fenced block, not the first: CLI output prepends sandbox and
	// bootstrap noise that sometimes contains JSON of its own.
	if fences := fencePattern.FindAllStringSubmatch(raw, -1); len(fences) > 0 {
		candidates = append(candidates, strings.TrimSpace(fences[len(fences)-1][1]))
	}
	candidates = append(candidates, raw)

	for _, candidate := range candidates {
		for _, variant := range []string{candidate, repairMissingOuterBrace(candidate)} {
			if plan, ok := decodePlan(variant); ok {
				return plan, validate(plan)
			}
		}
		// Nothing parsed whole. Scan for a balanced {...} that actually looks
		// like a plan — checking for "subtasks" rather than taking the first
		// brace pair, which would return whatever object appeared first in the
		// agent's reasoning.
		if plan, ok := scanForPlan(candidate); ok {
			return plan, validate(plan)
		}
	}
	return Plan{}, errors.New("the planner's reply did not contain a plan")
}

func decodePlan(text string) (Plan, bool) {
	var probe map[string]json.RawMessage
	if json.Unmarshal([]byte(text), &probe) != nil {
		return Plan{}, false
	}
	if _, ok := probe["subtasks"]; !ok {
		return Plan{}, false
	}
	var plan Plan
	if json.Unmarshal([]byte(text), &plan) != nil {
		return Plan{}, false
	}
	return plan, true
}

// repairMissingOuterBrace closes an object a model left open. Long replies get
// truncated mid-write often enough that discarding them wastes a complete plan.
func repairMissingOuterBrace(text string) string {
	text = strings.TrimSpace(text)
	if !strings.HasPrefix(text, "{") {
		return text
	}
	depth := 0
	inString, escaped := false, false
	for _, r := range text {
		switch {
		case escaped:
			escaped = false
		case r == '\\' && inString:
			escaped = true
		case r == '"':
			inString = !inString
		case inString:
			// Braces inside a string are not structure.
		case r == '{', r == '[':
			depth++
		case r == '}', r == ']':
			depth--
		}
	}
	if depth <= 0 {
		return text
	}
	// Close whatever is still open, innermost first. Arrays and objects are
	// tracked together, so guess ']' for a trailing array and '}' otherwise —
	// json.Unmarshal rejects a wrong guess and the caller moves on.
	closers := strings.Repeat("}", depth)
	if strings.LastIndex(text, "[") > strings.LastIndex(text, "{") {
		closers = "]" + strings.Repeat("}", depth-1)
	}
	return text + closers
}

// scanForPlan walks every balanced {...} substring and returns the first that
// is a plan.
//
// Checking each candidate for a "subtasks" key rather than taking the first
// brace pair: an agent's reply routinely opens with an object of its own
// reasoning, and accepting that would build a workflow out of it.
func scanForPlan(text string) (Plan, bool) {
	for start := 0; start < len(text); start++ {
		if text[start] != '{' {
			continue
		}
		end, ok := matchingBrace(text, start)
		if !ok {
			// Unbalanced from here on; no later start can close either.
			return Plan{}, false
		}
		if plan, ok := decodePlan(text[start : end+1]); ok {
			return plan, true
		}
		// Not a plan. Resume scanning AFTER this object rather than inside it,
		// so a nested object is not retried on its own.
		start = end
	}
	return Plan{}, false
}

// matchingBrace returns the index of the brace closing the one at start.
func matchingBrace(text string, start int) (int, bool) {
	depth, inString, escaped := 0, false, false
	for i := start; i < len(text); i++ {
		c := text[i]
		switch {
		case escaped:
			escaped = false
		case c == '\\' && inString:
			escaped = true
		case c == '"':
			inString = !inString
		case inString:
			// Braces inside a string are not structure.
		case c == '{':
			depth++
		case c == '}':
			depth--
			if depth == 0 {
				return i, true
			}
		}
	}
	return 0, false
}

func validate(plan Plan) error {
	if len(plan.Subtasks) == 0 {
		// A workflow with no work in it.
		return errors.New("the plan must contain at least one subtask")
	}
	if len(plan.Subtasks) > MaxSubtasks {
		return fmt.Errorf("the plan has too many subtasks (%d, maximum %d)", len(plan.Subtasks), MaxSubtasks)
	}

	seen := map[string]bool{}
	for _, task := range plan.Subtasks {
		id := strings.TrimSpace(task.ID)
		if id == "" {
			return errors.New("every subtask needs an id")
		}
		if seen[id] {
			// Ids become node ids; duplicates make edges ambiguous.
			return fmt.Errorf("duplicate subtask id: %s", id)
		}
		if strings.TrimSpace(task.Label) == "" {
			return fmt.Errorf("subtask %q needs a label", id)
		}
		seen[id] = true
	}
	return nil
}

// PlanToGraph turns a validated plan into nodes and edges.
//
// A subtask with no surviving dependency is wired to the SUPERVISOR. Without
// that edge it has no inbound path, so the scheduler never reaches it and the
// work silently does not happen.
func PlanToGraph(plan Plan, supervisorID, runtime, agent string) graph.Graph {
	known := make(map[string]bool, len(plan.Subtasks))
	for _, task := range plan.Subtasks {
		known[strings.TrimSpace(task.ID)] = true
	}

	out := graph.Graph{}
	for _, task := range plan.Subtasks {
		id := strings.TrimSpace(task.ID)
		out.Nodes = append(out.Nodes, graph.Node{
			ID: id, Type: "specialistAgent",
			Data: graph.NodeData{
				Label:              task.Label,
				Role:               task.Role,
				Objective:          task.Objective,
				SystemInstructions: task.SystemInstructions,
				RuntimeName:        runtime,
				SandboxAgent:       agent,
			},
		})

		// Dependencies on ids the model invented are dropped: an edge to a node
		// that does not exist makes the graph unschedulable.
		wired := 0
		for _, dep := range task.dependencies() {
			dep = strings.TrimSpace(dep)
			if dep == "" || dep == id || !known[dep] {
				continue
			}
			out.Edges = append(out.Edges, graph.Edge{
				ID: dep + "-" + id, Source: dep, Target: id,
			})
			wired++
		}
		if wired == 0 {
			out.Edges = append(out.Edges, graph.Edge{
				ID: supervisorID + "-" + id, Source: supervisorID, Target: id,
			})
		}
	}
	return out
}
