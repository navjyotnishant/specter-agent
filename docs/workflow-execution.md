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
- `--json` prints a machine-readable final result on stdout and streams live
  progress to stderr.
- `--quiet` suppresses live progress output for strict automation.

Project-level `CLAUDE.md` or `AGENTS.md` gate example:

```md
Before production build, release, or high-risk code change, run:

scripts/specter-agent security-review-team --workspace . --json

Proceed only if the command exits 0.
```

The backend start-run API also checks that the requested workspace path is
inside an active approved workspace before launching execution.

---

## Removed Pages

The following pages were removed — do not re-add routes or nav entries for them:

| Page | Removed because |
|---|---|
| `src/pages/Runs.tsx` (`/runs`) | Run history is now inline in `Workflows.tsx` |
| `src/pages/Approvals.tsx` (`/approvals`) | Approvals are handled in `WorkflowRun.tsx` |
