# Specter Agent — Agent Instructions

This file governs all AI agents working in this repository (Codex, Gemini, GPT-4, etc.).
Keep any other agent-specific instruction files in sync when they exist.

---

## Build & Deploy Workflow

### Mandatory pre-flight checklist — EVERY production build

**All required steps must be completed unless explicitly marked skippable. Do not skip a required step even if the user seems impatient.**

| Step | What | Gate |
|---|---|---|
| 1 | Localhost app starts cleanly | Hard stop if errors |
| 2 | User confirms manual testing on localhost | Wait for explicit confirmation |
| 3 | Run automated tests/build checks | Skippable if user explicitly requests |
| 4 | Post full report to Linear or the active issue tracker | Skippable if user explicitly requests |
| 5 | User reviews the report and explicitly approves | Wait for explicit "yes / approve / proceed" |
| 6 | Security review — no HIGH/CRITICAL findings unacknowledged | Hard stop if unacknowledged findings |

**If the user says "run build" without completing the above:**
> "Before I push to production, I need to complete the pre-flight checklist. Let me run the checks now..."
> Then execute steps 3-5 automatically before proceeding.

**The user may explicitly skip step 3 (tests/checks) and step 4 (issue-tracker report) by saying so.** If skipped, note it in the commit/issue log and proceed directly to step 5 (user approval) -> step 6 (security review) -> production build.

---

### Step 1 — Localhost App Startup

For full local container verification:

```bash
docker compose up -d --build
```

Check logs:

```bash
docker compose logs --tail 50 specter-agent
```

Confirm the FastAPI app starts without errors and SQLite initializes successfully.

For fast development without Docker:

```bash
VITE_API_BASE_URL=http://127.0.0.1:8000/api npm run dev -- --host 127.0.0.1
PYTHONPATH=backend SDLC_DATABASE_PATH=/tmp/specter-agent-dev.db .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Use `http://127.0.0.1:8080` for the frontend and `http://127.0.0.1:8000/api/health` for backend health.

---

### Step 2 — User Confirms Localhost Testing

Wait for the user to test the app locally and say it works. Do not proceed to release/build promotion without this confirmation.

---

### Step 3 — Run Automated Checks *(skippable)*

Run the checks that exist for this repo:

```bash
npm run build
npm run lint
PYTHONPATH=backend .venv/bin/python -m py_compile backend/app/main.py
```

When workflow persistence or backend runtime code changes, also run a SQLite smoke test that initializes the database and seeds the Security Review Team template.

If any check fails, report the failures and ask the user how to proceed. Do not auto-block unless the failure indicates a hard runtime or security issue.

---

### Step 4 — Post Report To Linear / Issue Tracker *(skippable with tests)*

Create or update the relevant issue in the Specter Agent project:

- **Title:** `Pre-production Test Report — <branch> — <YYYY-MM-DD>`
- **Description:** commands run, pass/fail status, notable warnings, and changed files
- **Label:** `test-report` when available
- **Status:** `Done` if all passed, `In Progress` if any failed
- **Priority:** High for release-blocking failures

Share the issue URL with the user. An issue URL is required before proceeding to step 5 unless the user explicitly skipped tests and the report.

---

### Step 5 — User Approves The Report

Present the issue/report URL and ask:
> "Checks complete — X passed, Y failed, Z skipped. Full report: `<issue-url>`. Do you approve the production build?"

Only proceed after explicit approval ("yes", "approve", "go ahead", "run the build", etc.).

---

### Step 6 — Security Review (mandatory before production build)

Perform a security review of all changes on the current branch vs main. Focus on:

- Auth bypasses and missing `require_user` / admin-only backend checks
- SQL injection, command injection, template injection, and unsafe dynamic execution
- Exposed secrets, API keys, tokens, or credentials in code, logs, memory, or artifacts
- Insecure direct object references across users, workflows, runs, approvals, and memory entries
- Unsafe filesystem access outside configured codebase/artifact/secrets volumes
- Agent/tool execution paths that lack allowlists, approval gates, or iteration limits

If any HIGH or CRITICAL vulnerabilities are found, stop and report them. Do not push to production until the user explicitly acknowledges or waives each finding.

---

### Production Build (only after all steps complete)

Use the repository's actual deployment path. If no production branch or server has been configured, stop and ask the user which target to use.

Typical branch flow:

```bash
git checkout main
git merge <current-feature-branch> --no-edit
git push origin main
git checkout <previous-feature-branch>
```

Never force-push or commit directly to a protected production branch.

After every production build, log shipped work in Linear or the active issue tracker. This is mandatory unless explicitly waived by the user.

---

## Project Runtime

- **Project:** Specter Agent / Local Multi-Agent SDLC Automation Platform
- **Repository:** `/Users/navjyotnishant/Desktop/github/navjyotnishant/specter-agent`
- **Frontend:** React, TypeScript, Vite, React Router, Tailwind CSS, shadcn/ui, lucide-react, TanStack React Query, React Flow via `@xyflow/react`
- **Backend:** Python, FastAPI, SQLite
- **Default frontend URL:** `http://127.0.0.1:8080`
- **Default backend URL:** `http://127.0.0.1:8000`
- **Backend health:** `GET /api/health`
- **Container service:** `specter-agent`
- **Container SQLite path:** `/app/data/app.db`
- **Recommended local volumes:** `./data:/app/data`, `./artifacts:/app/artifacts`, `./secrets:/app/secrets`, `./codebases:/app/codebases:ro`

---

## Branch Strategy

```
feature/<issue-key-or-short-name> -> main -> production target
```

- Prefer feature branches tied to the relevant issue key when issue tracking is active.
- Never force-push protected branches.
- Before every push, do a quick code review of the changes: focus on bugs, regressions, missing validation, and security issues.
- Before every push, run the `screenshot-docs-sync` skill (global skill,
  `~/.claude/skills/screenshot-docs-sync/SKILL.md`) to detect UI-relevant
  changes since the docs were last updated, refresh any affected screenshots
  under `docs/static/img/`, and edit the corresponding page(s) under
  `docs/docs/`. Commit the resulting documentation update as its own commit
  (`docs: ...`) before pushing, then push everything upstream together. Skip
  this step only when the diff has no UI-relevant changes (backend-only,
  test-only, or docs-only changes need no re-sync) — the skill itself
  determines this; don't skip it preemptively.

---

## Commit Style

- No `Co-Authored-By` in commits.
- Conventional commits: `feat:`, `fix:`, `chore:`, etc.
- Include the issue key in branch names and commits when an issue key exists.
- Before every commit, run `git diff --cached --stat` and confirm only intended files are staged.

---

## Linear / Issue Logging

**Use this workflow when Linear or another issue tracker is available and authenticated. If tracker tooling is unavailable, report the blocker clearly and continue only with the user's approval.**

### Project Mapping

- **Linear workspace:** Navjyot Labs
- **Linear team:** specter-agent (`SPE`)
- **Linear project:** `specter-agent`
- **Do not log Specter Agent work under EngageHub.** EngageHub is a separate project and workspace context.

### Task Gate — Before Substantial Code Changes

For every non-trivial task, bug fix, or feature request:

1. Search the tracker for an existing issue matching the work.
2. If found, confirm the issue key with the user, update the issue with the plan, set status to `In Progress`, then proceed.
3. If not found, create an issue under the `specter-agent` project in the Navjyot Labs workspace when the tracker is available:
   - Title: concise description of the task
   - Description: what will be done and why
   - Status: `In Progress`
   - Priority: match urgency (High for bugs, Medium for features)
   - Break into sub-tasks for non-trivial work
4. Share the issue URL before writing substantial code.
5. Include the issue key in branch names and commits when available.

If an issue cannot be confirmed or created because tooling is blocked, tell the user and ask whether to proceed without tracker logging.

### While Working

- As each sub-task is completed, mark it `Done` in the tracker when available.
- If the approach changes mid-implementation, update the issue description.
- If a separate bug fix is discovered and shipped mid-feature, log it on the parent issue or create a standalone fix issue.

### After Every Production Build

1. Identify shipped commits that are not yet reflected in the tracker.
2. For each, find the matching issue and update it with shipped commits and delivered changes.
3. Mark completed sub-tasks `Done`; mark the parent issue `Done` when all sub-tasks are complete.
4. Bug fixes and hotfixes must be logged.

---

## Testing

| What | Command | When |
|---|---|---|
| Frontend production build | `npm run build` | Before handoff or release |
| Frontend lint | `npm run lint` | Before handoff or release |
| Backend compile smoke | `PYTHONPATH=backend .venv/bin/python -m py_compile backend/app/main.py` | Backend changes |
| Backend health | `curl -sS http://127.0.0.1:8000/api/health` | When backend is running |

When dependencies are not installed, install frontend packages with `pnpm install` and backend packages with `.venv/bin/pip install -r backend/requirements.txt`.

Known lint baseline: shadcn/auth files may emit Fast Refresh warnings when modules export helpers and components together. Treat lint errors as failures; treat existing warnings as non-blocking unless the task touches those files.

---

## Local Artifacts — Never Commit

- `node_modules/`, `dist/`, `__pycache__/`, local SQLite databases, generated reports, local secrets, mounted codebases, and machine-specific env files.
- Treat `data/`, `artifacts/`, `secrets/`, and `codebases/` as local runtime state unless a task explicitly says otherwise.
- Do not delete, overwrite, or stage user-owned local state unless explicitly asked.

---

## Python Environment

- Prefer a local virtual environment at `.venv` for backend work.
- Prefer `.venv/bin/python` and `.venv/bin/pip` for Python commands.
- Use `.venv/bin/python -m ...` style for module execution.
- If `.venv` is absent and verification is needed, create one or use a temporary venv under `/tmp`.

---

## File Header Convention

For new scripts, migrations, and major standalone modules add:

```text
Primary author: <actual owner — do not derive from git config>
Created on: YYYY-MM-DD
Last updated: YYYY-MM-DD HH:MM TZ
Description: ...
AI usage: Built with assistance from AI tools for implementation acceleration, review, and refactoring.
```

Skip for small components or trivial files.

---

## Documentation Site

`docs/` is a Docusaurus project (not just loose markdown) — it holds the full
documentation site, mirroring README/AGENTS/AI_RULES/summary content plus the
guides. It builds and deploys to GitHub Pages via
`.github/workflows/docs.yml` on every push to `main` that touches `docs/**`.
Live site: https://navjyotnishant.github.io/specter-agent/

When editing top-level docs (README.md, AGENTS.md, AI_RULES.md, summary.md),
also update the corresponding mirrored page under `docs/docs/` so the two
don't drift:

| Root file | Mirrored page |
|---|---|
| `README.md` | `docs/docs/getting-started/overview.md`, `docs/docs/getting-started/local-operations.md` |
| `AGENTS.md` | `docs/docs/contributing/agent-instructions.md` |
| `AI_RULES.md` | `docs/docs/contributing/ai-rules.md` |
| `summary.md` | `docs/docs/architecture/project-summary.md` |

## Key Architecture Notes

- FastAPI app entrypoint: `backend/app/main.py`
- SQLite session/schema utilities: `backend/app/db/session.py`
- Workflow persistence and Security Review Team seeding: `backend/app/runtime/workflows.py`
- Workflow API routes: `backend/app/routers/workflows.py`
- Workflow run routes (start, steps, logs, approve, reject, revision, cancel): `backend/app/routers/runs.py`
- Auth uses bearer-token sessions stored in SQLite with password hashing via passlib/bcrypt.
- Sensitive API routes should use `require_user`; admin-only operations should enforce role checks.
- Workflow graphs are stored as JSON in the `workflows.graph_json` column.
- Built-in workflow and skill templates live under `backend/app/templates`.
- Frontend API client: `src/lib/api.ts`
- Type definitions: `src/lib/types.ts`
- Workflow list + run history page: `src/pages/Workflows.tsx`
- Workflow builder: `src/pages/WorkflowBuilder.tsx`
- Workflow execution/run view: `src/pages/WorkflowRun.tsx`
- React Flow node components: `src/components/workflow/nodes/`
- Agent inspector (node config panel): `src/components/agents/AgentInspector.tsx`

### Navigation — removed pages

The following pages were removed as their functionality is now covered inline:

- `Runs` — standalone run list replaced by inline run history in `Workflows.tsx`
- `Approvals` — standalone approval queue replaced by the approval panel in `WorkflowRun.tsx`

Do not re-add nav items or routes for `/runs` or `/approvals`.

### Workflow execution model

- A run is created via `POST /api/workflow-runs` with `workflow_id` and `workspace_path`.
- The graph is resolved from the saved workflow if not provided in the request body.
- Run status values: `queued` → `running` → `completed` / `failed` / `cancelled` / `waiting_approval`.
- Steps are stored in `agent_runs` joined to `workflow_step_runs`; logs in `run_logs`.
- Approval requests are stored in `approval_requests` with statuses: `pending`, `approved`, `rejected`, `revision_requested`.
- `resolution_comment` on `approval_requests` stores the reviewer's note.

### Human Approval node

- Configured in the builder via `AgentInspector` — `allowedActions` (array of `"approve"`, `"reject"`, `"request_revision"`) and `noteRequired` (bool) are stored in node `data` inside the graph JSON.
- The canvas card (`HumanApprovalNode`) renders colored action chips and a "note required" tag based on these fields.
- The runtime approval UI in `WorkflowRun.tsx` renders only the configured actions and enforces note requirement before enabling submission.
- Three backend endpoints: `POST /approve/{id}`, `POST /reject/{id}`, `POST /request-revision/{id}` — all accept `{ note: string }`.

### Docker Sandbox runtime

Specter prefers Docker Sandboxes over raw Codex CLI when `sbx` is installed and healthy.
Key facts for agents working in this codebase:

- Base image: `docker/sandbox-templates:codex` (not the Claude Code template)
- Exec command: `sbx create --clone --name <name> codex <workspace>` then `sbx exec <name> codex exec --sandbox read-only --json <prompt>` then `sbx rm --force <name>`
- Only `read-only` mode is supported. Write-capable sandbox tasks are out of scope.
- Network policy (deny-all / balanced / allow-all) is set via `sbx policy set-default` and surfaced in the Models page policy selector.
- Auth: `sbx secret set -g openai --oauth` on the host — never stored in the Docker container.
- Linux is not yet supported by Docker Sandboxes (macOS and Windows only).
- Full details: `docs/docs/guides/docker-sandbox.md` (or the [hosted guide](https://navjyotnishant.github.io/specter-agent/guides/docker-sandbox))

### Parallel lane color coding

- `topoLayout()` in `WorkflowRun.tsx` returns `{ nodes, colMap }` where `colMap` maps node ID → topological column (depth).
- `LANE_COLORS` array of 8 colors; `laneColor(col)` maps column index to a color.
- All nodes at the same topo depth (parallel branches) share the same color across: canvas node left-edge bar, flow edge stroke, run log dot, sidebar step card border.

---

## Agent Runtime Safety

- Enforce model, skill, tool, and connector allowlists per agent.
- Enforce filesystem/codebase path allowlists.
- Require approval before external write actions, destructive actions, or publishing reports outside local artifacts.
- Respect memory scopes (`workflow`, `team`, `agent_private`) and avoid storing secrets in memory.
- Enforce max iterations and context limits for agent loops.
- Default to local-first behavior and make external network/provider usage explicit.

---

## Attribution And Export Guardrails

- Do not remove or weaken creator attribution in internal UI or docs unless explicitly requested.
- Do not add creator attribution, debug text, or internal-only branding to client-facing export surfaces unless explicitly requested.

---

## Environment Notes

- Docker Compose currently defines a single service: `specter-agent`.
- The app is designed for local-first deployment with SQLite and mounted local volumes.
- When only Vite is running, the frontend may use preview-mode auth and sample data.
- When FastAPI is running, CRUD APIs and local auth persist to SQLite.
- Use `VITE_API_BASE_URL=http://127.0.0.1:8000/api` when the Vite dev server should talk to the backend directly.
