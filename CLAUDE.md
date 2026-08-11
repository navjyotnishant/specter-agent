# Specter Agent — Claude Code Instructions

## MANDATORY: Docker rebuild after every change

> **After every code change — no exceptions — run:**
> ```bash
> docker compose up -d --build
> ```
> Verify the container restarted before reporting anything as done. Never skip this step. Never ask the user if they want a rebuild — just do it.

## MANDATORY: Sync docs + screenshots before every push

> **Before running `git push` — no exceptions — run the `screenshot-docs-sync`
> global skill** (`~/.claude/skills/screenshot-docs-sync/SKILL.md`) to detect
> UI-relevant changes since the docs were last updated and refresh the
> affected pages/screenshots under `docs/`. Commit the doc update as its own
> `docs:` commit, then push everything upstream together. The skill itself
> decides whether a re-sync is needed (backend-only/test-only/docs-only diffs
> need none) — don't skip invoking it preemptively.

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

The backend is **Go, one binary**. `specter serve` is the API and the web UI;
`specter run` executes a workflow in its own process. Same artifact, two entry
points — there is no interpreter, no venv, and no second process to keep alive.

| What | Where |
|---|---|
| CLI + server entrypoint | `cmd/specter/` |
| HTTP router and handlers | `internal/api/` |
| Schema and queries | `internal/store/` (`schema.sql`, `migrations.sql`) |
| Workflow execution engine | `internal/runner/` |
| Graph parsing and scheduling | `internal/graph/` |
| Agent spawning, streaming, cancel | `internal/exec/` |
| OS confinement | `internal/confine/` |
| Worktree per run | `internal/worktree/` |
| Fernet, byte-compatible with Python | `internal/secretbox/` |
| Built-in skills + workflow templates | `internal/seed/` |
| State directory resolution | `internal/specterhome/` |
| Frontend API client | `src/lib/api.ts` |
| Type definitions | `src/lib/types.ts` |
| Workflows list + history | `src/pages/Workflows.tsx` |
| Workflow execution view | `src/pages/WorkflowRun.tsx` |
| Workflow builder | `src/pages/WorkflowBuilder.tsx` |
| React Flow nodes | `src/components/workflow/nodes/` |
| Node config inspector | `src/components/agents/AgentInspector.tsx` |
| End-to-end tests against the real binary | `test/e2e/` |
| Docs site (Docusaurus project) | `docs/` (built via `cd docs && npm run build`, deployed to GitHub Pages) |

## Development

```bash
# Frontend
VITE_API_BASE_URL=http://127.0.0.1:8000/api pnpm dev -- --host 127.0.0.1

# Backend — API and web UI
go run ./cmd/specter serve

# Run a workflow from the terminal, no server needed
go run ./cmd/specter run <workflow> --repo .

# What this machine can do right now
go run ./cmd/specter status

# Docker (full stack)
docker compose up -d --build
```

Frontend: `http://127.0.0.1:5173` · Backend health: `http://127.0.0.1:8000/api/health`

State lives in `~/.specter` (override with `SPECTER_HOME`), **not** in the
checkout — deleting the repository must not delete the run history or the key
that decrypts stored credentials.

## Docker build rule

**After every code change, always rebuild the Docker container before testing.** Docker caches layers aggressively — skipping the rebuild means the running container won't reflect your changes.

```bash
# Standard rebuild (uses layer cache where safe)
docker compose up -d --build

# Force full rebuild (use when COPY layers may be stale)
docker compose build --no-cache && docker compose up -d
```

Always verify the build succeeded and the container restarted before reporting a change as done.
