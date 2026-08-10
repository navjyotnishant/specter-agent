package runner

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/navjyotnishant/specter-agent/internal/graph"
)

// Approval timeout bounds, matching Python. A gate is clamped rather than
// trusted: a workflow configured with 0 hours would expire instantly and one
// with a year would hold a run open indefinitely.
const (
	defaultApprovalTimeout = 24 * time.Hour
	minApprovalTimeout     = 1 * time.Hour
	maxApprovalTimeout     = 30 * 24 * time.Hour
)

// defaultApprovalPoll is how often a blocked gate re-reads its row.
//
// A blocking poll costs a goroutine here rather than an OS thread, so Python's
// design ports directly. Keeping it means ONE execution model — the alternative,
// exiting and rescheduling, needs its own correctness argument for an approval
// that lands between the check and the exit.
const defaultApprovalPoll = 5 * time.Second

// approvalTimeout reads the node's configured timeout, clamped.
func (r *Runner) approvalTimeout(node graph.Node) time.Duration {
	if r.ApprovalTimeout != 0 {
		return r.ApprovalTimeout // test override, deliberately unclamped
	}
	if node.Data.TimeoutHours == 0 {
		return defaultApprovalTimeout
	}
	requested := time.Duration(node.Data.TimeoutHours) * time.Hour
	if requested < minApprovalTimeout {
		return minApprovalTimeout
	}
	if requested > maxApprovalTimeout {
		return maxApprovalTimeout
	}
	return requested
}

// runApprovalNode handles a humanApproval gate. Reports whether the run should
// continue.
//
// Resume is not a separate path: the main loop already skips completed nodes, so
// a restarted run walks back to this gate with everything before it intact. What
// this function adds is recognising a gate that is ALREADY resolved, so a
// restarted run does not wait for a second approval that will never come.
func (r *Runner) runApprovalNode(ctx context.Context, runID string, node graph.Node) bool {
	label := nodeLabel(node)

	stepID, approvalID, resolved := r.existingGate(runID, node.ID)
	switch {
	case resolved == "approved":
		// Already answered before this process started. Continue immediately.
		r.updateStep(stepID, "completed", "", "Approved by human reviewer.", "")
		r.setRunStatus(runID, "running")
		r.writeLog(runID, "info", "Approval already granted, continuing: "+label,
			map[string]any{"approval_id": approvalID})
		return true

	case resolved == "rejected" || resolved == "revision_requested":
		r.updateStep(stepID, "failed", "", "", "Approval rejected or revision requested.")
		r.setRunStatus(runID, "failed")
		r.writeLog(runID, "warn", "Run stopped: approval rejected or revision requested.", nil)
		return false

	case resolved == "expired":
		// The expiry already cancelled this run. Approving it later must not
		// resurrect anything.
		r.updateStep(stepID, "cancelled", "", "", "Approval expired without response.")
		r.setRunStatus(runID, "cancelled")
		r.writeLog(runID, "warn", "Run cancelled: approval expired without response.", nil)
		return false
	}

	if stepID == "" {
		var err error
		stepID, err = r.writeStep(runID, node, "running")
		if err != nil {
			return false
		}
	}
	if approvalID == "" {
		r.updateStep(stepID, "waiting_approval", "", gateReason(node), "")
		r.setRunStatus(runID, "waiting_approval")
		var err error
		approvalID, err = r.writeApprovalRequest(runID, stepID, node)
		if err != nil {
			r.updateStep(stepID, "failed", "", "", "Could not record the approval request: "+err.Error())
			r.setRunStatus(runID, "failed")
			return false
		}
		r.writeLog(runID, "info", "Paused at approval gate: "+label,
			map[string]any{"approval_id": approvalID})
	}

	switch r.waitForApproval(ctx, approvalID) {
	case "approved":
		r.updateStep(stepID, "completed", "", "Approved by human reviewer.", "")
		r.setRunStatus(runID, "running")
		r.writeLog(runID, "info", "Approval granted, continuing: "+label, nil)
		return true

	case "expired":
		// Cancelled, not failed: nothing went wrong, nobody answered.
		r.updateStep(stepID, "cancelled", "", "", "Approval expired without response.")
		r.setRunStatus(runID, "cancelled")
		r.writeLog(runID, "warn", "Run cancelled: approval expired without response.", nil)
		return false

	case "cancelled":
		r.updateStep(stepID, "cancelled", "", "Cancelled while waiting for approval.", "")
		r.setRunStatus(runID, "cancelled")
		return false

	default:
		r.updateStep(stepID, "failed", "", "", "Approval rejected or revision requested.")
		r.setRunStatus(runID, "failed")
		r.writeLog(runID, "warn", "Run stopped: approval rejected or revision requested.", nil)
		return false
	}
}

// existingGate finds a gate this run already opened, and how it was answered.
func (r *Runner) existingGate(runID, nodeID string) (stepID, approvalID, status string) {
	err := r.Store.DB().QueryRow(
		`SELECT id FROM agent_runs
		  WHERE workflow_run_id = ? AND node_id = ?
		  ORDER BY started_at DESC LIMIT 1`, runID, nodeID).Scan(&stepID)
	if errors.Is(err, sql.ErrNoRows) || err != nil {
		return "", "", ""
	}
	err = r.Store.DB().QueryRow(
		`SELECT id, status FROM approval_requests
		  WHERE workflow_step_run_id = ? ORDER BY created_at DESC LIMIT 1`, stepID).
		Scan(&approvalID, &status)
	if err != nil {
		return stepID, "", ""
	}
	return stepID, approvalID, status
}

func gateReason(node graph.Node) string {
	if reason := strings.TrimSpace(node.Data.Reason); reason != "" {
		return reason
	}
	return "Manual approval required before continuing."
}

func (r *Runner) writeApprovalRequest(runID, stepID string, node graph.Node) (string, error) {
	approvalID := uuid.NewString()
	title := strings.TrimSpace(node.Data.Label)
	if title == "" {
		title = "Human Approval Required"
	}
	expiresAt := time.Now().UTC().Add(r.approvalTimeout(node)).Format(time.RFC3339)

	_, err := r.Store.DB().Exec(
		`INSERT INTO approval_requests
		   (id, workflow_run_id, workflow_step_run_id, status, title, reason,
		    context_summary, requested_by_agent, expires_at)
		 VALUES (?, ?, ?, 'pending', ?, ?, ?, 'workflow-runner', ?)`,
		approvalID, runID, stepID, title, gateReason(node),
		"Workflow run "+runID+" paused at approval gate.", expiresAt)
	return approvalID, err
}

// waitForApproval blocks until the gate is answered, expires, or the run is
// cancelled.
//
// The context check is what lets POST /{id}/cancel release a run parked here.
// Without it cancel appears to do nothing until somebody answers the gate.
func (r *Runner) waitForApproval(ctx context.Context, approvalID string) string {
	poll := r.ApprovalPoll
	if poll <= 0 {
		poll = defaultApprovalPoll
	}
	ticker := time.NewTicker(poll)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return "cancelled"
		case <-ticker.C:
		}

		var status string
		var expiresAt sql.NullString
		err := r.Store.DB().QueryRow(
			`SELECT status, expires_at FROM approval_requests WHERE id = ?`, approvalID).
			Scan(&status, &expiresAt)
		if err != nil {
			return "missing"
		}
		switch status {
		case "approved", "rejected", "revision_requested", "expired":
			return status
		}

		// Expiry is evaluated HERE rather than by a timer: there is no scheduler
		// to miss, and a backend that was down over the deadline still notices.
		if expiresAt.Valid && expiresAt.String != "" {
			deadline, parseErr := ParseTimestamp(expiresAt.String)
			if parseErr == nil && !deadline.After(time.Now().UTC()) {
				// Guarded on 'pending' so a resolution racing this update wins.
				r.Store.DB().Exec(
					`UPDATE approval_requests SET status = 'expired', resolved_at = ?
					  WHERE id = ? AND status = 'pending'`, now(), approvalID)
				return "expired"
			}
		}
	}
}

// ParseTimestamp reads the formats both backends write: Python's isoformat and
// SQLite's CURRENT_TIMESTAMP.
// ParseTimestamp reads the formats both backends write.
func ParseTimestamp(value string) (time.Time, error) {
	value = strings.TrimSpace(strings.Replace(value, "Z", "+00:00", 1))
	for _, layout := range []string{
		time.RFC3339Nano, time.RFC3339,
		"2006-01-02T15:04:05.999999-07:00",
		"2006-01-02 15:04:05", "2006-01-02T15:04:05",
	} {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed.UTC(), nil
		}
	}
	return time.Time{}, errors.New("unrecognised timestamp: " + value)
}
