package runner

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/navjyotnishant/specter-agent/internal/exec"
	"github.com/navjyotnishant/specter-agent/internal/graph"
)

// conditionTimeout is short by design: a yes/no question that takes minutes has
// gone wrong, and a workflow should not sit behind a gate that long.
const conditionTimeout = 2 * time.Minute

// webhookTimeout bounds an outbound call to a URL the workflow author chose.
const webhookTimeout = 20 * time.Second

// evaluateCondition asks the agent a strict yes/no question and branches on the
// answer.
//
// Returns (status, branch, summary). branch is "true" or "false" and only means
// anything when status is "completed".
func (r *Runner) evaluateCondition(ctx context.Context, runID string, node graph.Node, workspace, context_ string) (status, branch, summary string) {
	condition := strings.TrimSpace(node.Data.Condition)
	if condition == "" {
		// Failing beats silently taking a branch nobody chose.
		return "failed", "", "Conditional node has no condition configured."
	}

	label := nodeLabel(node)
	parts := []string{
		"You are " + label + ", a conditional gate in a workflow. Question: " + condition + "\n" +
			"Respond with ONLY the single word YES or NO (all caps, no punctuation, no other text, " +
			"no explanation) based on the question and the context below.",
	}
	if memoryContext := r.memoryContextFor(runID); memoryContext != "" {
		parts = append(parts, "\nRelevant memory:\n"+lastN(memoryContext, stepContextLimit))
	}
	trigger, steps := splitTriggerContext(context_)
	if trigger != "" {
		parts = append(parts, "\nUser instruction for this run:\n"+trigger)
	}
	if steps != "" {
		parts = append(parts, "\nPrevious step context:\n"+lastN(steps, stepContextLimit))
	}

	agentPath := r.AgentPath
	if agentPath == "" {
		agentPath = exec.ResolveCLI(agentBinaries(node.AgentName()), nil)
	}
	if agentPath == "" {
		return "failed", "", "No " + node.AgentName() + " CLI found on this machine."
	}

	result := exec.RunStreaming(ctx, exec.Command{
		Argv:    []string{agentPath, strings.Join(parts, " ")},
		Dir:     workspace,
		Timeout: conditionTimeout,
	})
	if ctx.Err() != nil {
		return "cancelled", "", "Cancelled mid-execution."
	}
	if result.TimedOut {
		return "failed", "", "The condition check exceeded its time limit."
	}
	if !result.OK() {
		detail := strings.TrimSpace(result.Stderr)
		if detail == "" {
			detail = "Condition evaluation failed."
		}
		return "failed", "", lastN(detail, 2000)
	}

	answer := exec.FinalMessage(result.Stdout)
	if strings.TrimSpace(answer) == "" {
		answer = result.Stdout
	}
	branch = parseYesNo(answer)
	return "completed", branch, "Condition: " + condition + "\nAnswer: " + strings.ToUpper(branch)
}

// parseYesNo reads only the FIRST word.
//
// An agent told to answer "YES or NO" routinely answers "YES, because ...".
// Comparing the whole reply to "YES" sends every such run down the false branch
// and nothing looks broken. Punctuation is stripped for the same reason: "YES."
// is a yes.
//
// Anything unrecognised is FALSE. A gate that defaults to true on a confused
// answer runs the guarded branch by accident — and the guarded branch is the one
// somebody deliberately put a gate in front of.
func parseYesNo(answer string) string {
	fields := strings.Fields(strings.ToUpper(strings.TrimSpace(answer)))
	if len(fields) == 0 {
		return "false"
	}
	first := strings.Trim(fields[0], `.,!:;"'`)
	if first == "YES" || first == "TRUE" {
		return "true"
	}
	return "false"
}

// dispatchWebhook posts to the URL the workflow author configured. No agent is
// involved.
func (r *Runner) dispatchWebhook(ctx context.Context, runID string, node graph.Node, context_ string) (status, stdout, summary string) {
	url := strings.TrimSpace(node.Data.URL)
	if url == "" {
		return "failed", "", "Webhook node has no URL configured."
	}
	// http/https only. file:// would read a local file, and a bare host is a
	// typo rather than an address.
	if !strings.HasPrefix(url, "http://") && !strings.HasPrefix(url, "https://") {
		return "failed", "", "Webhook URL must start with http:// or https://."
	}

	method := strings.ToUpper(strings.TrimSpace(node.Data.Method))
	if method == "" {
		method = "POST"
	}

	trimmedContext := lastN(context_, stepContextLimit)
	body := strings.TrimSpace(node.Data.PayloadTemplate)
	if body == "" {
		encoded, _ := json.Marshal(map[string]string{
			"run_id": runID, "node": nodeLabel(node), "context": trimmedContext,
		})
		body = string(encoded)
	} else {
		body = strings.ReplaceAll(body, "{{context}}", trimmedContext)
	}

	requestCtx, cancel := context.WithTimeout(ctx, webhookTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(requestCtx, method, url, bytes.NewReader([]byte(body)))
	if err != nil {
		return "failed", "", fmt.Sprintf("Webhook %s %s failed: %v", method, url, err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "failed", "", fmt.Sprintf("Webhook %s %s failed: %v", method, url, err)
	}
	defer resp.Body.Close()

	// Capped: the endpoint is not ours and a huge body would land in a row the
	// UI renders inline.
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 2000))

	line := fmt.Sprintf("Webhook %s %s → %d", method, url, resp.StatusCode)
	if resp.StatusCode >= 400 {
		// A 500 reported as success lets the run continue as though the
		// notification landed.
		return "failed", "", line
	}
	detail := line
	if len(respBody) > 0 {
		detail += "\n" + string(respBody)
	}
	return "completed", line, detail
}
