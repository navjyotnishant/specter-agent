# Docker Sandboxes — Integration Reference

Specter Agent supports Docker Sandboxes as a preferred execution runtime over
raw Codex CLI. When `sbx` is installed and healthy, Specter routes agent tasks
through isolated microVM sandboxes instead of running Codex directly on the host.

Official references:
- Product: https://www.docker.com/products/docker-sandboxes/
- Codex agent docs: https://docs.docker.com/ai/sandboxes/agents/codex/
- Claude Code agent docs: https://docs.docker.com/ai/sandboxes/agents/claude-code/

---

## What Docker Sandboxes Is

Docker Sandboxes runs coding agents (Codex, Claude Code, Gemini CLI, Copilot CLI,
Kiro, and others) inside **disposable microVM environments**. Each sandbox:

- Has a hard hypervisor-level boundary from the host
- Mounts only the project workspace — nothing else from the host filesystem
- Gets its own isolated Docker daemon (no access to the host Docker daemon)
- Can install packages, run services, and modify files without touching the host
- Is ephemeral — deleted after the task completes

This makes it safe to run agents in `--dangerously-skip-permissions` / unattended
mode without risk to the host machine.

**Docker Desktop is not required.** The `sbx` CLI is a standalone install.

**Linux is not yet supported** (macOS and Windows only as of mid-2025).

---

## Installation

```bash
# macOS
brew install docker/tap/sbx

# Windows
winget install Docker.sbx
```

Authenticate Codex credentials inside sandboxes:

```bash
sbx secret set -g openai --oauth
```

---

## Sandbox Lifecycle in Specter Agent

Specter's host runner manages the full lifecycle via `run_sandbox_codex_task()`:

```
sbx create --clone --name <sandbox-name> codex <workspace-path>
  ↓
sbx exec <sandbox-name> codex exec --sandbox read-only --json <prompt>
  ↓
sbx rm --force <sandbox-name>   ← always runs, even on error/timeout
```

- Sandbox name is derived from the job token or `<workspace>-<timestamp>`,
  sanitized to alphanumeric + hyphens by `safe_sandbox_name()`.
- Base image: `docker/sandbox-templates:codex`
- Only `read-only` sandbox mode is currently supported. Write-capable tasks
  require explicit approval gates and are intentionally out of scope.

---

## Network Policy

Three policies, set via `sbx policy set-default` and exposed in the Models page:

| Policy | Behaviour |
|---|---|
| `deny-all` | No outbound network from inside the sandbox |
| `balanced` | Limited outbound — blocks sensitive endpoints (recommended) |
| `allow-all` | Full outbound network access |

Policy is read from `sbx policy ls` and stored/applied through:
- Host runner: `docker_sandbox_policy_status()` / `set_docker_sandbox_policy()`
- Backend: `GET/POST /api/runtime-adapters/docker-sandbox/policy`
- UI: policy selector on the Models page (admin only)

---

## Runtime Preference Logic

The Models page computes `preferredRuntime`:

1. If Docker Sandbox status is `ready` → **Docker** (preferred)
2. Else if Codex CLI status is `ready` → **Codex**
3. Else → host runner offline / neither available

When Docker Sandbox is preferred, `POST /api/workflow-runs` routes execution
through `call_host_runner("/runtimes/docker-sandbox/codex/run")` instead of
the raw Codex CLI path.

---

## Status Checks

The host runner's `docker_sandbox_status()` probes `sbx` and returns:

| `sandbox_health_status` | Meaning | UI message |
|---|---|---|
| `missing` | `sbx` not found on PATH | "Install Docker Sandboxes CLI." |
| `daemon_unavailable` | `sbx` installed but daemon not running | "Start Docker Sandboxes daemon." |
| `cli_available` | Installed and daemon healthy | `sbx <version>` |
| `ready` | Full status, Codex sandbox runnable | Ready for agent tasks |

---

## Security Model

| Property | Detail |
|---|---|
| Isolation | MicroVM hypervisor boundary (not OS-level containers) |
| Filesystem | Only project workspace mounted — no host home dir or secrets |
| Docker | Isolated Docker daemon inside sandbox; no host daemon access |
| Credentials | `sbx secret` stores credentials outside the sandbox via proxy |
| Network | Configurable via `sbx policy`; deny-all blocks all outbound |
| Recovery | Delete and recreate in seconds; no host cleanup required |

Specter Agent adds its own layer on top:
- Workspace must be in the approved workspaces list before any sandbox run
- All runs are recorded in SQLite with status, output, and workspace path
- Approval gates in the workflow graph are enforced before task dispatch

---

## Key Files

| File | Role |
|---|---|
| `scripts/specter_host_runner.py` | `docker_sandbox_status()`, `run_sandbox_codex_task()`, `set_docker_sandbox_policy()`, `safe_sandbox_name()` |
| `backend/app/routers/runtime_adapters.py` | `/docker-sandbox/status` and `/docker-sandbox/policy` routes |
| `src/pages/Models.tsx` | Status card, install dialog (`dockerSandboxMacInstallCommand`), policy selector |
| `src/lib/api.ts` | `dockerSandboxRuntimeStatus()`, `dockerSandboxPolicy()`, `setDockerSandboxPolicy()` |

---

## Claude Code vs Codex in Sandboxes

Specter Agent currently uses the **Codex** sandbox template
(`docker/sandbox-templates:codex`) and the `codex exec` command. The Claude Code
template (`docker/sandbox-templates:claude-code`) uses `sbx run claude` and is a
separate agent. If Claude Code sandbox support is added to Specter in future, the
base image and exec command would need to change and a separate auth flow
(`sbx secret set -g anthropic`) would be required.
