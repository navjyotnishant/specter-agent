// Package runner executes a workflow graph.
//
// Ported from backend/app/runtime/graph_runner.py. The prompt built here is
// what the agent actually receives, so any difference from Python is a
// behavioural difference in the product — the same workflow would produce
// different work depending on which backend started it.
package runner

import (
	"strings"

	"github.com/navjyotnishant/specter-agent/internal/graph"
)

// TriggerMarker prefixes the run context when the user supplied input at start.
// The exact string matters: Python writes it and Go must recognise what Python
// wrote, and vice versa, while both backends share one database.
const TriggerMarker = "[[trigger-input]]\n"

// stepContextLimit caps accumulated step output. The TAIL is kept — the most
// recent output is the relevant background.
const stepContextLimit = 1500

// splitTriggerContext separates the user's own instruction from accumulated
// step output. Step output is appended after a blank line.
func splitTriggerContext(context string) (trigger, steps string) {
	if context == "" || !strings.HasPrefix(context, TriggerMarker) {
		return "", context
	}
	body := context[len(TriggerMarker):]
	head, tail, found := strings.Cut(body, "\n\n")
	if !found {
		return strings.TrimSpace(head), ""
	}
	return strings.TrimSpace(head), strings.TrimSpace(tail)
}

// lastN keeps the final n characters. Counted in runes, not bytes, so a cut
// never lands mid-character and hands the agent a broken symbol.
func lastN(s string, n int) string {
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[len(runes)-n:])
}

// BuildPrompt assembles the instruction sent to the agent for one node.
func BuildPrompt(node graph.Node, context, memoryContext string) string {
	label := node.Data.Label
	if strings.TrimSpace(label) == "" {
		label = node.ID
	}

	var parts []string
	switch node.Type {
	case "supervisorAgent":
		goal := node.Data.Objective
		if strings.TrimSpace(goal) == "" {
			goal = "coordinate the workflow steps that follow"
		}
		parts = append(parts,
			"You are "+label+", a supervisor agent. Objective: "+goal+". "+
				"Do a QUICK scoping pass of this workspace: list the top 5 files or areas most "+
				"relevant to the objective, then write a 3-bullet action plan for the downstream agents. "+
				"Be concise — respond in under 300 words. Do NOT explore every file.")
		if node.Data.SystemInstructions != "" {
			parts = append(parts, "Additional context: "+node.Data.SystemInstructions)
		}

	case "specialistAgent":
		focus := node.Data.Role
		if strings.TrimSpace(focus) == "" {
			focus = label
		}
		parts = append(parts,
			"You are "+label+", a specialist agent focused on: "+focus+". "+
				"Do a targeted check — look at 2-3 relevant files maximum. "+
				"Report your findings in under 200 words with bullet points. "+
				"Do NOT do an exhaustive scan.")
		if node.Data.Objective != "" {
			parts = append(parts, "Objective: "+node.Data.Objective)
		}
		if node.Data.SystemInstructions != "" {
			parts = append(parts, "Instructions: "+node.Data.SystemInstructions)
		}
	}

	if memoryContext != "" {
		parts = append(parts,
			"\nRelevant memory from earlier in this run (use as background only):\n"+
				lastN(memoryContext, stepContextLimit))
	}

	trigger, steps := splitTriggerContext(context)
	if trigger != "" {
		// NEVER truncated. This is the user's own instruction, and the head of a
		// pasted draft matters more than its tail — cutting it would silently
		// drop the part they cared about most.
		parts = append(parts,
			"\nThe user supplied this when starting the run. Treat it as your "+
				"instruction and act on it directly:\n"+trigger)
	}
	if steps != "" {
		// Truncated to its TAIL, on purpose: the most recent output is the
		// relevant background.
		parts = append(parts, "\nPrevious step context (use as background only):\n"+
			lastN(steps, stepContextLimit))
	}

	parts = append(parts, "\nRespond with a short structured summary only. Be concise.")
	return strings.Join(parts, " ")
}
