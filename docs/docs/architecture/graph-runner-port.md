# Porting the graph runner

`graph_runner.py` is the last hard piece of the Go rewrite and the one most
likely to re-earn bugs already fixed in Python. This document scopes it before
any of it is written.

## Why it is not "five more endpoints"

Five endpoints are blocked on this — `POST /workflow-runs`, the three approval
resolutions, and cancel. They look like a small remainder next to the 50 already
ported. They are not: each is a thin HTTP wrapper over a **957-line execution
engine** that has no Go equivalent.

What Go already has is the *substrate*, not the orchestration:

| Package | What it does | Used by the runner for |
|---|---|---|
| `internal/exec` | spawn an agent, stream output, track and cancel jobs | running one node |
| `internal/graph` | cycle detection | validating the graph |
| `internal/worktree` | a checkout per run | isolating the workspace |
| `internal/confine` | `sandbox-exec` confinement | containing the agent |
| `internal/publish` | write runs produce a PR | the write path |
| `internal/store` | schema, runs, steps, logs | persistence |

The runner is what sits on top: scheduling, state transitions, suspend/resume,
and recovery. None of that exists yet.

## What the engine actually does

### Seven node types

| Type | Behaviour |
|---|---|
| `trigger` | entry point; carries the run input |
| `supervisorAgent` | plans and delegates; prompt built from the graph |
| `specialistAgent` | executes one task with its allowed skills |
| `memory` | reads and writes run-scoped memory |
| `humanApproval` | **suspends the run** until a human resolves it |
| `conditional` | branches on agent output |
| `webhook` | posts to an external URL |

### Level-based parallel scheduling

Nodes are grouped into topological levels and each level runs in parallel via a
thread pool. `humanApproval` nodes are split into **singleton levels of their
own** — an approval that ran alongside three agents would gate nothing, because
the actions it exists to authorise would already be in flight.

### Suspend and resume — the sharpest part

**Correction to an earlier reading of this file.** An initial pass through
`graph_runner.py` recorded that a `humanApproval` node writes its row, marks the
run `waiting_approval`, and *the thread exits*. That is wrong, and it matters
because it would have produced a different design.

What actually happens: `_wait_for_approval()` **blocks in a five-second polling
loop**, holding the worker thread for as long as the gate is open — potentially
hours. The run is suspended in the database *and* parked in memory.

That is why `recover_approved_waiting_runs()` exists. A backend restart kills the
blocked thread, so at startup any run that is `waiting_approval` **and** whose
approval is already `approved` is started again **from the top**. Nothing
replays: the main loop skips nodes whose latest step is already `completed` and
folds their summaries back into context, so re-running walks straight back to the
gate and continues past it.

So resume is not a special path. It is the ordinary loop plus the completed-step
skip, which is why R1–R3 already contain most of it.

Three failure modes, all of which strand a run:

- Resuming from the wrong node re-runs work that already happened, and an agent
  that already wrote files writes them twice. The completed-step skip is what
  prevents this, and it is already tested.
- Not resuming at all leaves the run `waiting_approval` forever, with the UI
  showing an approved gate on a dead run. Recovery at startup is what prevents
  this.
- Resuming a run whose approval **expired** contradicts the expiry that already
  cancelled it.

**A Go-specific decision.** A blocking poll per gate costs a goroutine rather
than an OS thread, so the Python design ports directly and cheaply. Keeping it
means one execution model rather than two — and the alternative, exiting and
rescheduling, would need its own correctness argument for the case where the
approval lands between the check and the exit.

### Approval expiry

Pending approvals carry an `expires_at`. On expiry the approval becomes
`expired`, its step and agent run become `cancelled`, the run becomes
`cancelled`, and a warning is logged. This runs **on read**, not on a timer — so
any endpoint that touches approvals may mutate state as a side effect.

## The host-runner dependency

`_call_host_runner()` posts to `http://host.docker.internal:8765` because a
container has no agent binary and no credentials. **Native Go does not need this
hop at all** — `internal/exec` spawns the agent directly, which is the entire
premise of the rewrite.

So the port is not a transcription. The runner's node execution should call
`internal/exec` in process, and the HTTP path becomes the container-only
fallback rather than the default. That is a simplification, but it also means
the two implementations genuinely diverge here, and the Python version stays the
reference for *behaviour*, not for *structure*.

## Proposed order

Each phase ends somewhere useful, and nothing depends on a later phase.

**R1 — Scheduling, no execution.** Topological levels, approval nodes forced
into singleton levels, cycle rejection. Pure functions over a graph, tested
against the same graphs Python schedules. No database, no subprocess.

**R2 — Run one node.** `specialistAgent` only, through `internal/exec`, writing
`workflow_step_runs`, `agent_runs`, `run_logs`. A single-node workflow runs end
to end. `POST /workflow-runs` can land here.

**R3 — The rest of the node types.** `supervisorAgent`, `memory`, `conditional`,
`webhook`, `trigger`. Each is independently testable.

**R4 — Suspend and resume.** `humanApproval`, the three resolution endpoints,
expiry, and startup recovery. The riskiest phase; it gets its own tests for each
of the three stranding modes above.

**R5 — Cancellation.** `POST /{id}/cancel`, killing an in-flight job through the
context already threaded into `internal/exec`.

## What must be true before this is called done

- A workflow with an approval gate suspends, survives a **backend restart**, and
  resumes on approval — not just in a test, but against the real UI.
- A rejected approval cancels the run and does not leave the step running.
- An expired approval cancels the run, and a later approval of it does not
  resurrect anything.
- Cancelling a running node actually kills the subprocess.
- A run that fails mid-graph leaves every step in a terminal state; nothing sits
  at `running` with no process behind it.

## Cost

This is comparable to everything done in the API port so far. It is the phase
where a rewrite most easily reintroduces bugs the Python version already fixed,
and the approval flow is in active use — three approval requests and one
`revision_requested` run existed in the database before it was cleared.

Treat R4 as the point to slow down rather than the point to finish quickly.
