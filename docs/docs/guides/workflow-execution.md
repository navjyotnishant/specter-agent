---
id: workflow-execution
title: Workflow Execution
sidebar_position: 1
---

# Workflow Execution — Architecture and UI Reference

This document covers the workflow execution model, the run execution view, the
approval gate, and the Workflows page run-management UX.

---

## Workflows Page (`src/pages/Workflows.tsx`)

### Layout

- **My Workflows** tab — user-created workflows, runnable, editable, publishable.
- **Templates** tab — shared templates; "Use template" copies to a new editable workflow.
- Each row expands inline to show run history when clicked anywhere on the row.
  Only the actions cell (`<td>`) stops propagation to prevent accidental expansion.

### Active-run locking

When a workflow has a run with status `running`, `queued`, or `waiting_approval`,
the row enters a locked state:

- **Run button** — disabled, grey, shows a spinner and status text
  ("Running…" or "Awaiting approval…").
- **Edit button** — disabled, 50% opacity, `cursor: not-allowed`,
  tooltip "Cannot edit while a run is active".
- **Publish as template button** — disabled with same treatment.

This prevents concurrent runs and editing a live workflow graph mid-execution.

### Run history panel

Clicking a row expands an inline history panel showing up to 20 recent runs per
workflow, each with status badge, start time, and a link to the full run view.

---

## WorkflowRun Page (`src/pages/WorkflowRun.tsx`)

The execution view is a three-panel layout:

```
┌──────────────┬───────────────────────────────┬─────────────────┐
│  Left pane   │        Canvas (React Flow)     │   Right pane    │
│  Step list   │        Node execution graph    │   Log drawer    │
│  (foldable)  │                                │  (resizable)    │
└──────────────┴───────────────────────────────┴─────────────────┘
│                    Run log panel (drag-resizable)               │
└─────────────────────────────────────────────────────────────────┘
```

### Left pane

- Lists all workflow steps with status icons.
- Collapses to a 40 px strip showing status icon circles.
- Clicking a circle in collapsed mode expands the pane and selects that step.

### Right pane (LogDrawer)

- Resizable: drag the left edge handle between 280–700 px.
- Shows step detail, agent output, and the approval panel when the selected
  step is a Human Approval gate.
- Root element has `minWidth: 0; overflow: hidden` and output div has
  `wordBreak: break-word` to prevent text clipping when the pane is wide.

### Run log panel

- Pinned at the bottom, drag-resizable between 80–500 px via a top-edge handle.
- Show/Hide toggle button to collapse entirely.
- Each log entry has a colored dot matching the node's parallel lane color.

---

## Parallel Lane Color Coding

All nodes at the same topological depth (i.e., running in parallel) share a color.
This color is applied consistently across the entire UI:

| Surface | How color is applied |
|---|---|
| Canvas node | 3 px left-edge color bar on `ExecNode` |
| Flow edge | Stroke color + animated glow dot on `FlowEdge` |
| Run log entry | Colored dot next to each log line in `RunLogPanel` |
| Sidebar step card | Left border in `LogDrawer` |

### Implementation

```ts
// topoLayout() returns { nodes, colMap }
// colMap: Record<nodeId, topoColumn>

const LANE_COLORS = ["#7c3aed","#2563eb","#0891b2","#059669",
                     "#d97706","#dc2626","#7c3aed","#0f766e"];

function laneColor(col: number): string {
  return LANE_COLORS[col % LANE_COLORS.length];
}
```

---

## Human Approval Gate

### Builder configuration (`AgentInspector.tsx`)

Three fields stored in the node's `data` object inside the workflow graph JSON:

| Field | Type | Default | Description |
|---|---|---|---|
| `allowedActions` | `string[]` | `["approve","reject","request_revision"]` | Which action buttons appear in the runtime approval UI |
| `noteRequired` | `boolean` | `false` | Whether the reviewer must enter a note before any action is available |
| `timeoutHours` | `number` | `24` | Hours before a pending approval expires and cancels the workflow |

The gate configuration is persisted in the workflow graph JSON. Each runtime
approval request also stores its concrete `expires_at` timestamp in SQLite.

### Canvas card (`HumanApprovalNode.tsx`)

- Renders colored action chips for each entry in `allowedActions`.
- Shows an amber "note required" tag when `data.noteRequired` is true.
- Shows the configured timeout window.

### Runtime approval UI (`WorkflowRun.tsx` → `LogDrawer`)

- Note textarea always visible.
- `canSubmit` is `true` only when: note is non-empty if `noteRequired`, and a
  valid action is selected, and the approval has not expired.
- Action buttons are rendered only for actions present in `allowedActions`.
- Shows the approval expiry deadline. Once expired, the approval can no longer
  be submitted.

### Backend endpoints (`backend/app/routers/runs.py`)

All three endpoints accept `{ note: string }` in the request body and persist
the note to `approval_requests.resolution_comment`.

| Endpoint | Effect |
|---|---|
| `POST /workflow-runs/{run_id}/approve/{approval_id}` | Sets approval status `approved` |
| `POST /workflow-runs/{run_id}/reject/{approval_id}` | Sets approval status `rejected` |
| `POST /workflow-runs/{run_id}/request-revision/{approval_id}` | Sets approval status `revision_requested`, marks run `failed` |

Pending approvals are expired before they are listed or resolved. Expiry sets
the approval status to `expired`, cancels the waiting step, and marks the
workflow run `cancelled`, so execution cannot proceed after no response.

### API client (`src/lib/api.ts`)

```ts
approveRun(token, runId, approvalId, note?)
rejectRun(token, runId, approvalId, note?)
requestRevision(token, runId, approvalId, note?)
```

---

## Backend Parallel Execution (`backend/app/runtime/graph_runner.py`)

The runner walks the graph **level by level** instead of node by node. Each
level is a set of nodes whose dependencies are already satisfied, so they have
no ordering constraint relative to each other.

```python
topological_levels(nodes, edges) -> list[list[node]]
```

- Depth of a node = `max(depth of its parents) + 1` (Kahn's algorithm, same
  math as the frontend's `topoLayout`/`colMap`).
- `humanApproval` nodes are always split into their own singleton level, so
  the existing pause/resume/expiry machinery is untouched — a level either
  contains only agent/memory nodes, or exactly one approval gate.

Within a level, `_run_level(...)` executes nodes concurrently via
`ThreadPoolExecutor`, bounded by `MAX_PARALLEL_NODES` (default 3):

- A level with 1 node (or `max_parallel <= 1`) runs inline — no thread pool
  overhead.
- Each node's summary is appended to `accumulated_context` only **after** the
  whole level joins, in deterministic node order — no cross-thread mutation
  during execution.
- If any node in a level fails, its siblings are allowed to finish first, then
  the run is marked `failed`. This means resume-after-fix only has to re-run
  the failed node — completed siblings are skipped via `_latest_step_for_node`.
- Cancellation is checked between levels; in-flight nodes are killed by their
  own progress-poller (`_poll_progress` → `_kill_job`) once it observes the
  run's status flip to `cancelled`.

### Turning parallelism on

Concurrency is driven by the **supervisor node's `delegationStrategy`**:

| `delegationStrategy` | `MAX_PARALLEL_NODES` | Behavior |
|---|---|---|
| `sequential_delegation` (default) | 1 | Levels still computed, but always run one node at a time — identical to the old sequential runner. |
| `parallel_delegation` | 3 | Nodes sharing a dependency frontier run concurrently, up to 3 at once. |

Set this in the Builder → select the Supervisor node → Agent tab →
**Delegation strategy**.

---

## Smart Supervisor Planning (`backend/app/runtime/supervisor.py`)

Instead of hand-wiring every specialist node, the Supervisor Agent can
**decompose an objective into a subgraph automatically**, using its own
configured CLI agent (Codex / Claude Code / Cursor, direct or sandboxed).

### Flow

1. In the Builder, select a **Supervisor Agent** node and fill in its
   **Objective** field (e.g. *"Do a full security review of this repo:
   code, dependencies, secrets, ending in a report"*).
2. Click **Plan workflow**. The backend runs the supervisor's agent inside
   the selected workspace with a planning prompt (see below), parses its
   JSON response, and returns a specialist subgraph.
3. The frontend lays the generated nodes out to the right of the supervisor
   (`layoutGeneratedSubgraph` in `src/lib/graph-layout.ts`, built on the same
   `topoLayout` column math used by the run view) and merges them into the
   canvas. The generated workflow is **auto-saved to the database**, so it's
   immediately runnable from the UI, `scripts/specter-agent`, or the API —
   no separate "publish" step.
4. Review/edit the generated nodes like any other node. Two refinement paths:
   - **Refine plan** (on the supervisor): free-text feedback regenerates the
     whole generated subgraph, replacing it in place.
   - **Tune with prompt** (on each generated specialist): a short instruction
     rewrites just that node's `label`/`role`/`objective`/`systemInstructions`.

### Generated graph shape

Every node/edge the planner creates is tagged `data.generatedBy: <supervisorNodeId>`,
so re-planning or refining only touches nodes it created — manually added
nodes and edges are never removed.

```json
{
  "id": "gen-sup-1-code-review",
  "type": "specialistAgent",
  "data": {
    "label": "Application Code Security Reviewer",
    "role": "Secure code review",
    "objective": "Review auth middleware and API routes for injection and access-control flaws.",
    "runtime": "direct",
    "sandboxAgent": "codex",
    "generatedBy": "sup-1"
  }
}
```

Edges chain specialists per their `depends_on`; specialists with no
dependencies connect directly from the supervisor. The planner may also emit
a `humanApproval` node (gating the risky/final steps) and a `memory` node
(durable summary) when warranted — both wired downstream of the specialists
they cover.

### Endpoints (`backend/app/routers/workflows.py`)

| Endpoint | Purpose |
|---|---|
| `POST /workflows/plan` | `{objective, supervisor_node_id, runtime, agent, workspace_path, system_instructions?, current_plan?, feedback?}` → `{nodes, edges}`. `current_plan`+`feedback` trigger a refinement instead of a fresh plan. |
| `POST /workflows/plan/tune-node` | `{node_data, instruction, runtime, agent, workspace_path}` → updated `{label, role, objective, systemInstructions}` for one node. |

Both call the host runner directly (`/runtimes/direct-cli/run` or
`/runtimes/docker-sandbox/run`, whichever the supervisor is configured for),
same dispatch path as normal node execution. Planning responses are validated
strictly: JSON must be extractable (fenced or bare), every `depends_on` must
reference a real subtask, and the dependency graph must be acyclic — bad
output surfaces as `422` with a human-readable message instead of a garbled
canvas.

### Example: security review, end to end

```bash
# 1. Supervisor objective (set in the Builder UI):
#    "Do a full security review of this repo: source code vulnerabilities,
#     dependency risks, and secrets handling, ending in a consolidated report."
#    Supervisor delegation strategy: parallel_delegation

# 2. Click "Plan workflow" — the supervisor (Codex, direct) inspects the repo
#    and returns something like:
#      code-review, deps-audit, secrets-config, infra-deploy, test-qa   (parallel)
#        └──────────────────────┬───────────────────────────────┘
#                          report (depends on all five)
#                     approval gate (after all five)
#                        memory synthesis (final)

# 3. Save happens automatically. Trigger it like any other workflow:
scripts/specter-agent "Full Security Review" --workspace /path/to/target/repo

# The five specialists run concurrently (parallel_delegation), the report
# waits for all of them, a human approval gate pauses before the summary is
# written to memory.
```

---

## Run Lifecycle

```
queued → running → completed
                 → failed
                 → cancelled
                 → waiting_approval → (approve) → running → completed
                                    → (reject)  → failed
                                    → (revise)  → failed
```

Run status is polled from `GET /api/workflow-runs/{run_id}` by the
`WorkflowRun` page using TanStack Query with a 2-second refetch interval while
the run is active.

---

## Terminal Execution

The recommended local entrypoint is the wrapper:

```bash
scripts/specter-agent <workflow-id-or-slug> --workspace .
```

The wrapper uses the same local FastAPI auth token as the web app. If
`SPECTER_TOKEN` is not set and no cached token exists, it prompts for Specter
email/password, validates the token, and caches it at:

```text
~/.specter-agent/token.json
```

The cache file is written with user-only permissions. For non-interactive
automation, set `SPECTER_TOKEN` explicitly.

```bash
scripts/specter-agent <workflow-id-or-slug> --workspace . --json
```

Advanced users can still call the lower-level CLI directly with
`scripts/specter_cli.py`.

Behavior:

- Resolves the workflow by id, exact name, or slugified name.
- Resolves the requested path to an approved Specter runtime workspace.
- Prompts for login only when no valid token is available.
- Starts the workflow via `POST /api/workflow-runs`.
- Streams run logs while waiting.
- Prints the web evidence URL for the run.
- Exits `0` only when the workflow status is `completed`.
- Exits non-zero for failed, cancelled, timed-out, unapproved workspace, auth,
  unavailable API, or missing workflow cases.
- `--json` prints a machine-readable final result on stdout and streams
  color-coded live progress to stderr.
- `--quiet` suppresses live progress output for strict automation.
- `--no-color` disables ANSI color in terminal progress output.

Project-level `CLAUDE.md` or `AGENTS.md` gate example:

```md
Before production build, release, or high-risk code change, run:

scripts/specter-agent security-review-team --workspace . --json

Proceed only if the command exits 0.
```

**Caveat for coding-assistant-driven gates**: `scripts/specter-agent` is a
single long-blocking process (the workflow run itself can take minutes). A
human running it from a terminal, or a CI job step, blocks on it naturally and
that's fine. But when a coding assistant's own tool-use loop invokes it as a
shell command, some harnesses schedule long-running commands in the
background instead of blocking — so the assistant may not reliably wait for
the result before proceeding (e.g. committing). For an **assistant-facing**
gate (as opposed to a plain git hook or CI step), use the
[pre-commit gate skill](#pre-commit-gate-for-coding-assistants) below instead
(same page — Docusaurus generates this heading anchor automatically), which
polls over short HTTP calls rather than one long CLI call.

The backend start-run API also checks that the requested workspace path is
inside an active approved workspace before launching execution.

---

## Pre-commit Gate for Coding Assistants

`scripts/precommit-gate/` is a distributable scaffold for gating commits on a
Specter workflow — in **other** repositories, driven either by a real git hook
or by a coding assistant.

| File | Purpose |
|---|---|
| `scripts/precommit-gate/SKILL.md` | Copy into a target repo's `.claude/skills/` (or the user's global `~/.claude/skills/`) so a coding assistant runs the gate via short, synchronous HTTP calls instead of one long CLI call. |
| `scripts/precommit-gate/pre-commit` | Copy into a target repo's `.git/hooks/pre-commit` (`chmod +x`) as the real enforcement layer — calls `scripts/specter-agent` directly, since a git hook is run by git itself and blocks natively regardless of the CLI call's length. |

Both paths call the same backend (`POST /workflow-runs`, `GET
/workflow-runs/{run_id}`) and require the same setup: the target repo's path
registered as an approved Specter workspace, plus `SPECTER_TOKEN` /
`SPECTER_API_BASE_URL` / `SPECTER_WORKFLOW_ID` set in the environment. See
`scripts/precommit-gate/SKILL.md` for the full setup and step-by-step protocol
the assistant follows (start run → poll status → report pass/fail).

The `pre-commit` hook script skips (exit 0) with a warning if
`SPECTER_WORKFLOW_ID` is unset, so copying the file speculatively doesn't
break commits before setup is finished.

---

## Removed Pages

The following pages were removed — do not re-add routes or nav entries for them:

| Page | Removed because |
|---|---|
| `src/pages/Runs.tsx` (`/runs`) | Run history is now inline in `Workflows.tsx` |
| `src/pages/Approvals.tsx` (`/approvals`) | Approvals are handled in `WorkflowRun.tsx` |
