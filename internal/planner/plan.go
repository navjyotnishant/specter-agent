package planner

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	execpkg "github.com/navjyotnishant/specter-agent/internal/exec"
	"github.com/navjyotnishant/specter-agent/internal/graph"
)

// Timeouts. Planning inspects a repository and thinks; tuning edits four fields.
const (
	planTimeout = 3 * time.Minute
	tuneTimeout = 90 * time.Second
)

const planSchemaExample = `{
  "subtasks": [
    {"id": "code-review", "label": "Code Security Reviewer", "role": "Auth middleware reviewer", "objective": "Review auth middleware and API routes for injection and access-control flaws.", "depends_on": []},
    {"id": "deps-audit", "label": "Dependency Auditor", "role": "Dependency vulnerability auditor", "objective": "Check dependency manifests for vulnerable or outdated packages.", "depends_on": []},
    {"id": "report", "label": "Report Writer", "role": "Findings report writer", "objective": "Aggregate all findings into a severity-rated report.", "depends_on": ["code-review", "deps-audit"]}
  ]
}`

// Planner asks an agent to decompose an objective.
type Planner struct {
	// AgentPath overrides CLI resolution; tests set it.
	AgentPath string
}

type Request struct {
	Objective          string
	SupervisorNodeID   string
	Runtime            string
	Agent              string
	WorkspacePath      string
	SystemInstructions string
	CurrentPlan        json.RawMessage
	Feedback           string
}

// ErrPlannerUnavailable means no agent CLI could be found to plan with.
var ErrPlannerUnavailable = errors.New("no agent CLI is available to plan with")

// BuildPlanningPrompt assembles the instruction. Kept separate from the call so
// it can be asserted without spawning anything.
func BuildPlanningPrompt(req Request) string {
	parts := []string{
		"You are a supervisor agent planning a multi-agent workflow.",
		"OBJECTIVE: " + req.Objective,
	}
	if instructions := strings.TrimSpace(req.SystemInstructions); instructions != "" {
		parts = append(parts, "SUPERVISOR INSTRUCTIONS: "+instructions)
	}
	parts = append(parts,
		"You are running inside the target repository. Spend at most a minute inspecting the "+
			"top-level layout (manifests, main directories) to ground your plan. Do NOT do a deep scan.")
	parts = append(parts,
		"Decompose the objective into 3-7 subtasks, each handled by one specialist agent. "+
			"Give every subtask a UNIQUE, specific role: a 2-4 word descriptor of what that agent "+
			"does (e.g. 'Auth middleware reviewer', not 'code review'). No two subtasks may share "+
			"the same role. Rules: tasks that are independent must have disjoint depends_on lists "+
			"(they will run in parallel); a task that consumes another task's output must list that "+
			"task in depends_on; a final aggregation/report task must depend on every task it "+
			"summarizes.")

	if len(req.CurrentPlan) > 0 && string(req.CurrentPlan) != "null" {
		// A revision, not a fresh plan. Stable ids matter: the builder keeps
		// node positions by id, so regenerating them scrambles the canvas.
		parts = append(parts, "CURRENT PLAN (JSON):\n"+string(req.CurrentPlan))
		feedback := strings.TrimSpace(req.Feedback)
		if feedback == "" {
			feedback = "Improve the plan."
		}
		parts = append(parts, "USER FEEDBACK: "+feedback+
			"\nRevise the current plan according to the feedback. Keep the ids of unchanged subtasks stable.")
	}

	parts = append(parts,
		"Respond with ONLY a JSON object matching this schema — no prose, no markdown fences:\n"+
			planSchemaExample)
	return strings.Join(parts, "\n\n")
}

// Plan asks the agent and returns the resulting subgraph.
func (p *Planner) Plan(ctx context.Context, req Request) (graph.Graph, error) {
	reply, err := p.ask(ctx, BuildPlanningPrompt(req), req, planTimeout)
	if err != nil {
		return graph.Graph{}, err
	}
	plan, err := ExtractPlan(reply)
	if err != nil {
		return graph.Graph{}, err
	}
	return PlanToGraph(plan, req.SupervisorNodeID, req.Runtime, req.Agent), nil
}

// TunedNode is one node's editable configuration.
type TunedNode struct {
	Label              string `json:"label"`
	Role               string `json:"role"`
	Objective          string `json:"objective"`
	SystemInstructions string `json:"systemInstructions"`
}

// TuneNode refines a single node per a user instruction.
func (p *Planner) TuneNode(ctx context.Context, current TunedNode, instruction string, req Request) (TunedNode, error) {
	encoded, _ := json.MarshalIndent(current, "", "  ")
	prompt := "You are refining the configuration of one specialist agent inside a multi-agent workflow.\n\n" +
		"CURRENT CONFIGURATION (JSON):\n" + string(encoded) + "\n\n" +
		"USER INSTRUCTION: " + strings.TrimSpace(instruction) + "\n\n" +
		"Update the configuration per the instruction. Keep values concise. " +
		`Respond with ONLY a JSON object containing exactly these keys: ` +
		`"label", "role", "objective", "systemInstructions". No prose, no markdown fences.`

	reply, err := p.ask(ctx, prompt, req, tuneTimeout)
	if err != nil {
		return TunedNode{}, err
	}

	body, ok := firstJSONObject(reply)
	if !ok {
		return TunedNode{}, errors.New("the agent's reply did not contain a configuration")
	}
	var tuned TunedNode
	if err := json.Unmarshal([]byte(body), &tuned); err != nil {
		return TunedNode{}, errors.New("the agent's reply was not valid JSON")
	}
	if strings.TrimSpace(tuned.Label) == "" {
		// A node with no label is unidentifiable on the canvas.
		return TunedNode{}, errors.New("the tuned node must keep a non-empty label")
	}
	return tuned, nil
}

func (p *Planner) ask(ctx context.Context, prompt string, req Request, timeout time.Duration) (string, error) {
	exe := p.AgentPath
	if exe == "" {
		agent := strings.TrimSpace(req.Agent)
		if agent == "" {
			agent = "claude"
		}
		names := []string{agent}
		if agent == "cursor" {
			names = []string{"cursor-agent", "cursor"}
		}
		exe = execpkg.ResolveCLI(names, nil)
	}
	if exe == "" {
		return "", ErrPlannerUnavailable
	}

	result := execpkg.RunStreaming(ctx, execpkg.Command{
		Argv: []string{exe, prompt}, Dir: req.WorkspacePath, Timeout: timeout,
	})
	if result.TimedOut {
		return "", errors.New("the planner did not answer in time")
	}
	if !result.OK() {
		detail := strings.TrimSpace(result.Stderr)
		if detail == "" {
			detail = "the planner failed"
		}
		return "", errors.New(detail)
	}

	reply := execpkg.FinalMessage(result.Stdout)
	if strings.TrimSpace(reply) == "" {
		reply = result.Stdout
	}
	return reply, nil
}

// firstJSONObject finds a balanced object in a reply that may carry prose.
func firstJSONObject(text string) (string, bool) {
	if fences := fencePattern.FindAllStringSubmatch(text, -1); len(fences) > 0 {
		candidate := strings.TrimSpace(fences[len(fences)-1][1])
		if json.Valid([]byte(candidate)) {
			return candidate, true
		}
	}
	for start := 0; start < len(text); start++ {
		if text[start] != '{' {
			continue
		}
		end, ok := matchingBrace(text, start)
		if !ok {
			return "", false
		}
		if json.Valid([]byte(text[start : end+1])) {
			return text[start : end+1], true
		}
		start = end
	}
	return "", false
}
