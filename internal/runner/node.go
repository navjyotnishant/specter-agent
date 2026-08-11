package runner

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/navjyotnishant/specter-agent/internal/agenthost"
	"github.com/navjyotnishant/specter-agent/internal/exec"
	"github.com/navjyotnishant/specter-agent/internal/graph"
	"github.com/navjyotnishant/specter-agent/internal/isolation"
	"github.com/navjyotnishant/specter-agent/internal/store"
)

// Runner executes workflow nodes.
//
// Unlike Python, this spawns the agent IN PROCESS through internal/exec. The
// Python runner posts to host.docker.internal:8765 because a container has no
// agent binary and no credentials; a native binary already lives on the machine
// that has both, so the HTTP hop is a container-only fallback rather than the
// default path.
type Runner struct {
	Store *store.Store
	// AgentPath overrides CLI resolution. Set by tests; empty means resolve the
	// agent named on the node.
	AgentPath   string
	NodeTimeout time.Duration
	// ApprovalPoll is how often a blocked gate re-reads its row. Tests shorten
	// it; zero means the default.
	ApprovalPoll time.Duration
	// ApprovalTimeout overrides the node's configured gate timeout. Tests only —
	// deliberately unclamped so an already-expired gate can be exercised.
	ApprovalTimeout time.Duration

	// NetworkPolicy bounds what the agent may reach. Zero value allows
	// everything, which is the current default and is reported as such by the
	// Warden rather than implied to be a boundary.
	NetworkPolicy isolation.NetworkPolicy
}

const defaultNodeTimeout = 30 * time.Minute

// NodeResult is what one node produced.
type NodeResult struct {
	StepID  string
	Status  string // completed | failed | cancelled | waiting_approval
	Summary string
	Stdout  string
	// Branch is "true"/"false" for a completed conditional, else empty.
	Branch string
}

func now() string { return time.Now().UTC().Format("2006-01-02 15:04:05") }

// writeStep opens a step. ONE id is written to BOTH workflow_step_runs and
// agent_runs: they are related by shared primary key, not a foreign key, which
// is what makes the /steps endpoint's `LEFT JOIN ... ON ws.id = ar.id` work.
// Writing separate ids produces rows that look right in isolation and never
// join.
func (r *Runner) writeStep(runID string, node graph.Node, status string) (string, error) {
	stepID := uuid.NewString()
	label := node.Data.Label
	if strings.TrimSpace(label) == "" {
		label = node.ID
	}
	role := node.Data.Role
	if strings.TrimSpace(role) == "" {
		role = node.Type
		if role == "" {
			role = "agent"
		}
	}
	model := node.Data.Model
	if strings.TrimSpace(model) == "" {
		model = node.AgentName() + " (auto)"
	}

	tx, err := r.Store.DB().Begin()
	if err != nil {
		return "", err
	}
	defer tx.Rollback()

	if _, err := tx.Exec(
		`INSERT OR REPLACE INTO workflow_step_runs (id, workflow_run_id, node_id, node_type, status, started_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		stepID, runID, node.ID, node.Type, status, now()); err != nil {
		return "", err
	}
	if _, err := tx.Exec(
		`INSERT OR REPLACE INTO agent_runs
		   (id, workflow_run_id, node_id, agent_name, agent_role, model, status, started_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		stepID, runID, node.ID, label, role, model, status, now()); err != nil {
		return "", err
	}
	return stepID, tx.Commit()
}

// updateStep closes a step in both tables and records the agent's output.
func (r *Runner) updateStep(stepID, status, output, summary, errText string) error {
	tx, err := r.Store.DB().Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.Exec(
		`UPDATE workflow_step_runs SET status = ?, completed_at = ? WHERE id = ?`,
		status, now(), stepID); err != nil {
		return err
	}
	var summaryValue, errValue any
	if summary != "" {
		summaryValue = summary
	}
	if errText != "" {
		errValue = errText
	}
	if _, err := tx.Exec(
		`UPDATE agent_runs SET status = ?, completed_at = ?, summary = ?, error = ? WHERE id = ?`,
		status, now(), summaryValue, errValue, stepID); err != nil {
		return err
	}
	if output != "" {
		// Capped: an agent that prints a whole file would otherwise put it in a
		// row the UI renders inline.
		if _, err := tx.Exec(
			`INSERT INTO agent_messages (id, agent_run_id, sender_type, sender_name, content)
			 VALUES (?, ?, 'agent', 'output', ?)`,
			uuid.NewString(), stepID, lastN(output, 20000)); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (r *Runner) writeLog(runID, level, message string, metadata map[string]any) {
	encoded := "{}"
	if metadata != nil {
		if raw, err := json.Marshal(metadata); err == nil {
			encoded = string(raw)
		}
	}
	// Logging is best-effort: failing a run because its log line would not
	// write is worse than losing the line.
	r.Store.DB().Exec(
		`INSERT INTO run_logs (id, workflow_run_id, level, message, metadata_json)
		 VALUES (?, ?, ?, ?, ?)`,
		uuid.NewString(), runID, level, message, encoded)
}

// RunNode executes one node end to end: open the step, run the agent, close the
// step, and record what happened.
//
// It never returns without the step in a terminal state. A step left at
// "running" with no process behind it is what makes the UI spin forever on a
// run that is already over.
func (r *Runner) RunNode(ctx context.Context, runID string, node graph.Node, workspace, context_ string) NodeResult {
	label := node.Data.Label
	if strings.TrimSpace(label) == "" {
		label = node.ID
	}

	r.writeLog(runID, "info", "Starting node: "+label,
		map[string]any{"node_id": node.ID, "node_type": node.Type})

	stepID, err := r.writeStep(runID, node, "running")
	if err != nil {
		return NodeResult{Status: "failed", Summary: "Could not record the step: " + err.Error()}
	}

	status, stdout, summary := r.execute(ctx, runID, node, workspace, context_)
	result := NodeResult{StepID: stepID, Status: status, Summary: summary, Stdout: stdout}
	if node.Type == "conditional" && status == "completed" {
		result.Branch = stdout
	}

	if status == "cancelled" {
		r.updateStep(stepID, "cancelled", "", "Cancelled mid-execution.", "")
		r.writeLog(runID, "info", "Run cancelled during node: "+label, nil)
		return result
	}

	errText := ""
	if status == "failed" {
		errText = summary
	}
	r.updateStep(stepID, status, stdout, summary, errText)

	level := "info"
	if status != "completed" {
		level = "error"
	}
	r.writeLog(runID, level, "Node "+label+": "+status, map[string]any{"node_id": node.ID})

	// Memory is written only on success. A failure recorded here would be fed
	// to every later node as background, so one broken step poisons the rest of
	// the run.
	if status == "completed" && summary != "" {
		scope := node.Data.MemoryScope
		if strings.TrimSpace(scope) == "" {
			scope = "workflow"
		}
		r.writeMemory(runID, stepID, scope, label, summary)
	}
	return result
}

// writeMemory records a node's output as background for later nodes.
//
// A failure here is LOGGED, not discarded. memory_entries has a foreign key to
// workflow_runs, so a missing parent row makes the insert fail — and with the
// error dropped, the only symptom was a later node running blind, which reads
// as a prompt-building bug rather than a write that never happened. A run is
// still worth finishing without its memory, so this does not fail the node.
func (r *Runner) writeMemory(runID, stepID, scope, key, value string) {
	if _, err := r.Store.DB().Exec(
		`INSERT INTO memory_entries (id, workflow_run_id, agent_run_id, scope, key, value_text, created_by_agent)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		uuid.NewString(), runID, stepID, scope, key, value, key,
	); err != nil {
		_ = r.Store.AppendLog(context.Background(), runID, "warning",
			fmt.Sprintf("could not record memory for %q: %v — later nodes will not see this output", key, err))
	}
}

// execute dispatches on node type. Only agent nodes are implemented in R2;
// everything else lands in R3 and R4 and is refused explicitly rather than
// silently reported as completed.
func (r *Runner) execute(ctx context.Context, runID string, node graph.Node, workspace, context_ string) (status, stdout, summary string) {
	switch node.Type {
	case "supervisorAgent", "specialistAgent":
		return r.runAgent(ctx, runID, node, workspace, context_)

	case "memory":
		// A memory node is an agent that summarises rather than investigates.
		// Its output is written to memory by the caller, the same as any other
		// completed node.
		return r.runAgent(ctx, runID, node, workspace, context_)

	case "conditional":
		return r.evaluateCondition(ctx, runID, node, workspace, context_)

	case "webhook":
		return r.dispatchWebhook(ctx, runID, node, context_)

	case "trigger":
		// Inputs, not work. The value was folded into the run context before the
		// first level executed, so the node only records what it supplied.
		field := strings.TrimSpace(node.Data.FieldName)
		if field == "" {
			field = "input"
		}
		return "completed", "", "Trigger supplied \u201c" + field + "\u201d."

	default:
		return "failed", "", fmt.Sprintf("Node type %q is not supported by this backend yet.", node.Type)
	}
}

func (r *Runner) runAgent(ctx context.Context, runID string, node graph.Node, workspace, context_ string) (status, stdout, summary string) {
	memoryContext := r.memoryContextFor(runID)
	prompt := BuildPrompt(node, context_, memoryContext)

	timeout := r.NodeTimeout
	if timeout == 0 {
		timeout = defaultNodeTimeout
	}

	var result exec.Result

	// A containerized backend has no agent binary and no credentials, so it asks
	// a host-side spawner instead. Unset means spawn here, which is the native
	// deployment and the default. AgentPath (a test injecting a fake agent)
	// always wins, so this never reaches the network in tests.
	if host := agenthost.Configured(); host != "" && r.AgentPath == "" {
		spawned, err := agenthost.NewClient().Spawn(ctx, agenthost.SpawnRequest{
			Agent:          node.AgentName(),
			Prompt:         prompt,
			Workspace:      workspace,
			TimeoutSeconds: int(timeout.Seconds()),
		})
		if err != nil {
			// Named as a host problem. Reporting "no agent CLI found" here would
			// send someone to install an agent they already have, on the wrong
			// machine.
			return "failed", "", err.Error()
		}
		result = spawned
	} else {
		agentPath := r.AgentPath
		if agentPath == "" {
			agentPath = exec.ResolveCLI(agentBinaries(node.AgentName()), nil)
		}
		if agentPath == "" {
			return "failed", "", noAgentMessage(node.AgentName())
		}

		// One proxy per node, closed when the node ends: a proxy that outlives
		// the agent it bounded is a hole left open.
		env := os.Environ()
		if r.NetworkPolicy.Restricted() {
			proxy, err := isolation.StartProxy(r.NetworkPolicy)
			if err != nil {
				return "failed", "", "could not start the network proxy: " + err.Error()
			}
			defer proxy.Close()
			proxy.OnRefused = func(host, reason string) {
				r.writeLog(runID, "warning", "network refused: "+host+" — "+reason, nil)
			}
			env = isolation.ProxyEnv(env, proxy.Addr())
		}

		result = exec.RunStreaming(ctx, exec.Command{
			Argv:    []string{agentPath, prompt},
			Dir:     workspace,
			Env:     env,
			Timeout: timeout,
		})
	}

	// Cancellation is checked FIRST. A killed process also reports a non-zero
	// exit, so testing OK() first would report every cancellation as a failure —
	// and cancelled and failed are different things to an operator: one they
	// did, one happened to them.
	if ctx.Err() != nil {
		return "cancelled", result.Stdout, "Cancelled mid-execution."
	}
	if result.TimedOut {
		return "failed", result.Stdout, fmt.Sprintf("The agent exceeded its time limit of %s.", timeout)
	}
	if result.Err != "" {
		return "failed", result.Stdout, "The agent could not be started: " + result.Err
	}
	if !result.OK() {
		detail := strings.TrimSpace(result.Stderr)
		if detail == "" {
			detail = strings.TrimSpace(result.Stdout)
		}
		if detail == "" {
			detail = fmt.Sprintf("exit code %d", result.ExitCode)
		}
		return "failed", result.Stdout, "The agent failed: " + lastN(detail, 2000)
	}

	final := exec.FinalMessage(result.Stdout)
	if strings.TrimSpace(final) == "" {
		final = strings.TrimSpace(result.Stdout)
	}
	return "completed", result.Stdout, final
}

// memoryContextFor gathers run-scoped memory as background for the next node.
func (r *Runner) memoryContextFor(runID string) string {
	rows, err := r.Store.DB().Query(
		`SELECT key, value_text FROM memory_entries
		  WHERE workflow_run_id = ? AND scope IN ('workflow', 'team')
		  ORDER BY created_at ASC`, runID)
	if err != nil {
		return ""
	}
	defer rows.Close()

	var parts []string
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			continue
		}
		parts = append(parts, key+": "+value)
	}
	return strings.Join(parts, "\n")
}

// agentBinaries maps an agent name to the binaries that provide it. cursor
// ships as cursor-agent on some installs and cursor on others.
func agentBinaries(agent string) []string {
	switch agent {
	case "cursor":
		return []string{"cursor-agent", "cursor"}
	default:
		return []string{agent}
	}
}

// noAgentMessage explains a missing CLI in terms of where it is missing.
//
// Inside a container the answer is never "install it" — a container has no agent
// binary and no credentials by design, and telling an operator to install one
// there sends them to fix the wrong machine. Naming the container and pointing
// at the host spawner is the actionable version.
func noAgentMessage(agent string) string {
	if inContainer() {
		return "No " + agent + " CLI in this container, and no agent host is configured. " +
			"Agents cannot run inside a container: set " + agenthost.AddrEnv +
			" and run `specter agent-host` on your machine."
	}
	return "No " + agent + " CLI found on this machine."
}

// inContainer detects Docker cheaply. /.dockerenv is created by the daemon, and
// its absence on a non-container is reliable enough for a message.
func inContainer() bool {
	_, err := os.Stat("/.dockerenv")
	return err == nil
}
