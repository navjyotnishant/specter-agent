# Specter Agent — Claude Code Instructions

## MANDATORY: Docker rebuild after every change

> **After every code change — no exceptions — run:**
> ```bash
> docker compose up -d --build
> ```
> Verify the container restarted before reporting anything as done. Never skip this step. Never ask the user if they want a rebuild — just do it.

## Canonical rules

All AI agent rules for this repository are defined in [AGENTS.md](AGENTS.md).
Read `AGENTS.md` before making any non-trivial change. It covers:

- Mandatory pre-flight checklist before every production build
- Branch strategy and commit style
- Linear issue-logging workflow (team `SPE`, project `specter-agent`)
- Testing commands for frontend and backend
- Agent runtime safety constraints
- Local artifact exclusions and Python environment conventions

## Quick reference

| What | Where |
|---|---|
| FastAPI entrypoint | `backend/app/main.py` |
| SQLite schema | `backend/app/db/session.py` |
| API routers | `backend/app/routers/` |
| Run/approval endpoints | `backend/app/routers/runs.py` |
| Runtime helpers | `backend/app/runtime/` |
| Frontend API client | `src/lib/api.ts` |
| Type definitions | `src/lib/types.ts` |
| Workflows list + history | `src/pages/Workflows.tsx` |
| Workflow execution view | `src/pages/WorkflowRun.tsx` |
| Workflow builder | `src/pages/WorkflowBuilder.tsx` |
| React Flow nodes | `src/components/workflow/nodes/` |
| Node config inspector | `src/components/agents/AgentInspector.tsx` |
| Built-in templates | `backend/app/templates/` |
| Codex host runner | `scripts/specter_host_runner.py` |
| Host runner docs | `docs/codex-cli-host-runner.md` |
| Docker Sandbox docs | `docs/docker-sandbox.md` |
| Workflow execution docs | `docs/workflow-execution.md` |

## Development

```bash
# Frontend
VITE_API_BASE_URL=http://127.0.0.1:8000/api pnpm dev -- --host 127.0.0.1

# Backend
PYTHONPATH=backend .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000

# Host runner
python3 scripts/specter_host_runner.py

# Docker (full stack)
docker compose up -d --build
```

Frontend: `http://127.0.0.1:5173` · Backend health: `http://127.0.0.1:8000/api/health`

## Docker build rule

**After every code change, always rebuild the Docker container before testing.** Docker caches layers aggressively — skipping the rebuild means the running container won't reflect your changes.

```bash
# Standard rebuild (uses layer cache where safe)
docker compose up -d --build

# Force full rebuild (use when COPY layers may be stale)
docker compose build --no-cache && docker compose up -d
```

Always verify the build succeeded and the container restarted before reporting a change as done.
