package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/navjyotnishant/specter-agent/internal/planner"
)

// planWorkflow decomposes an objective into a subgraph.
//
// The workspace is checked against the allowlist first: planning RUNS AN AGENT
// in that directory, so it is the same boundary as starting a run. Treating it
// as a read-only preview would let anyone point an agent at any directory by
// asking for a plan instead of a run.
func (d *Deps) planWorkflow(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Objective          string          `json:"objective"`
		SupervisorNodeID   string          `json:"supervisor_node_id"`
		Runtime            string          `json:"runtime"`
		Agent              string          `json:"agent"`
		WorkspacePath      string          `json:"workspace_path"`
		SystemInstructions string          `json:"system_instructions"`
		CurrentPlan        json.RawMessage `json:"current_plan"`
		Feedback           string          `json:"feedback"`
	}
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if strings.TrimSpace(req.Objective) == "" {
		writeError(w, http.StatusBadRequest, "An objective is required.")
		return
	}
	if strings.TrimSpace(req.SupervisorNodeID) == "" {
		writeError(w, http.StatusBadRequest, "A supervisor node id is required.")
		return
	}

	workspace, err := d.approvedWorkspace(req.WorkspacePath)
	if err != nil {
		writeError(w, http.StatusForbidden, err.Error())
		return
	}

	engine := &planner.Planner{AgentPath: d.AgentPath}
	graph, err := engine.Plan(context.Background(), planner.Request{
		Objective:          req.Objective,
		SupervisorNodeID:   req.SupervisorNodeID,
		Runtime:            req.Runtime,
		Agent:              req.Agent,
		WorkspacePath:      workspace,
		SystemInstructions: req.SystemInstructions,
		CurrentPlan:        req.CurrentPlan,
		Feedback:           req.Feedback,
	})
	if err != nil {
		if errors.Is(err, planner.ErrPlannerUnavailable) {
			// 503, not 500: nothing is broken, an agent is simply not installed.
			writeError(w, http.StatusServiceUnavailable, err.Error())
			return
		}
		writeError(w, http.StatusBadGateway, "The planner could not produce a plan: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, graph)
}

func (d *Deps) tuneNode(w http.ResponseWriter, r *http.Request) {
	var req struct {
		NodeData      planner.TunedNode `json:"node_data"`
		Instruction   string            `json:"instruction"`
		Runtime       string            `json:"runtime"`
		Agent         string            `json:"agent"`
		WorkspacePath string            `json:"workspace_path"`
	}
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if strings.TrimSpace(req.Instruction) == "" {
		writeError(w, http.StatusBadRequest, "An instruction is required.")
		return
	}

	workspace, err := d.approvedWorkspace(req.WorkspacePath)
	if err != nil {
		writeError(w, http.StatusForbidden, err.Error())
		return
	}

	engine := &planner.Planner{AgentPath: d.AgentPath}
	tuned, err := engine.TuneNode(context.Background(), req.NodeData, req.Instruction,
		planner.Request{Runtime: req.Runtime, Agent: req.Agent, WorkspacePath: workspace})
	if err != nil {
		if errors.Is(err, planner.ErrPlannerUnavailable) {
			writeError(w, http.StatusServiceUnavailable, err.Error())
			return
		}
		writeError(w, http.StatusBadGateway, "The agent could not tune this node: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, tuned)
}
