# Docker Sandboxes — Integration Reference

Specter Agent supports Docker Sandboxes as a preferred execution runtime over
raw Codex CLI. When `sbx` is installed and healthy, Specter routes agent tasks
through isolated microVM sandboxes instead of running Codex directly on the host.

> **Privacy guarantee**: your source code and data never leave your machine.
> All sandboxes run locally in a microVM on your host. No code is uploaded to
> Docker, Anthropic, OpenAI, or any Specter server as part of execution.

Official references:
- Product: https://www.docker.com/products/docker-sandboxes/
- Codex agent docs: https://docs.docker.com/ai/sandboxes/agents/codex/
- Claude Code agent docs: https://docs.docker.com/ai/sandboxes/agents/claude-code/
- Cursor agent docs: https://docs.docker.com/ai/sandboxes/agents/cursor/

---

## What Docker Sandboxes Is

Docker Sandboxes runs coding agents (Codex, Claude Code, Cursor, Gemini CLI,
Copilot CLI, Kiro, and others) inside **disposable microVM environments**. Each
sandbox:

- Has a hard hypervisor-level boundary from the host
- Mounts only the project workspace — nothing else from the host filesystem
- Gets its own isolated Docker daemon (no access to the host Docker daemon)
- Can install packages, run services, and modify files without touching the host
- Is ephemeral — deleted after the task completes

This makes it safe to run agents in `--dangerously-skip-permissions` / unattended
mode without risk to the host machine.

**Docker Desktop is not required.** The `sbx` CLI is a standalone install.

**Linux is not yet supported** (macOS and Windows only as of mid-2026).

---

## Installation

```bash
# macOS
brew install docker/tap/sbx

# Windows
winget install Docker.sbx
```

### Authentication

`sbx` requires a Docker account (free tier works). You must sign in once — the
session persists until it expires, after which you re-run `sbx login`.

```bash
# Sign in to Docker (opens browser)
sbx login
```

Then authenticate each agent's credentials inside sandboxes:

```bash
# Codex (OpenAI)
sbx secret set -g openai --oauth

# Cursor
sbx secret set -g cursor
```

### Claude Code — one-time interactive login

Claude Code uses a subscription OAuth token that cannot be extracted as a static API key.
Instead, you need to log in once interactively inside an sbx sandbox:

```bash
# Open an interactive Claude Code sandbox
sbx run --name claude-login claude /path/to/any-project

# Inside the sandbox, run:
/login
```

Follow the browser OAuth flow. Once complete, exit the sandbox — credentials are stored
in the sbx secret store and persist across all future Specter runs. You will not need to
repeat this unless you reset your sbx secrets.

If a Specter sandbox test returns **"Claude Code sandbox requires a one-time login"**, this
is the step you need to complete.

> **Alternative**: if you have an Anthropic API key (not subscription), you can use:
> `sbx secret set -g anthropic` and enter the key — no interactive login needed.

You only need to authenticate the agents you intend to use.

> **Session expiry**: if the Specter Models page shows `daemon_unavailable` or
> the sandbox status turns red unexpectedly, run `sbx diagnose` in your terminal.
> If it reports "not signed in", run `sbx login` — the daemon is still running,
> only your Docker auth token has expired.

---

## Sandbox Lifecycle in Specter Agent

Specter's host runner manages the full lifecycle via `run_sandbox_agent_task()`:

```
sbx run --clone --name <sandbox-name> <agent> <workspace-path> -- <prompt>
  ↓
(agent runs inside microVM, stdout streamed back)
  ↓
sbx rm --force <sandbox-name>   ← always runs, even on error/timeout
```

- Sandbox name is derived from the job token or `<workspace>-<timestamp>`,
  sanitized to alphanumeric + hyphens by `safe_sandbox_name()`.
- The agent key (`codex`, `claude`, `cursor`) selects the base image and run command
  from `_SANDBOX_AGENTS` in the host runner.
- Only `read-only` sandbox mode is currently supported.

---

## Shared Daemon

`sbx` runs a **single shared daemon** regardless of how many agents are configured.
There is no per-agent daemon — Codex, Claude Code, and Cursor all run through the
same daemon, each in their own isolated microVM using different base images. The
daemon status card on the Models page reflects the shared daemon health; the agent
selector (Codex / Claude Code / Cursor) only affects which template is used.

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

When Docker Sandbox is preferred, workflow execution routes through
`/runtimes/docker-sandbox/run` on the host runner.

---

## Status Checks

The host runner's `docker_sandbox_status()` probes `sbx` and returns:

| `sandbox_health_status` | Meaning | UI message |
|---|---|---|
| `missing` | `sbx` not found on PATH | "Install Docker Sandboxes CLI." |
| `daemon_unavailable` | `sbx` installed but daemon not running | "Start Docker Sandboxes daemon." |
| `cli_available` | Installed and daemon healthy | `sbx <version>` |
| `ready` | Full status, sandbox runnable | Ready for agent tasks |

Common causes of `daemon_unavailable`:
- `sbx` session expired → run `sbx login`
- Daemon stopped → run `sbx daemon start`
- Run `sbx diagnose` for a full breakdown

---

## Data Privacy — Your Code Never Leaves Your Machine

**All execution is local.** Your source code, files, and workspace data are
processed entirely on your own machine inside a microVM. Nothing is uploaded to
Docker, Anthropic, OpenAI, or any third-party service as part of running a task.

Specifically:
- The sandbox mounts your local workspace directory directly — no copy is made to
  any remote server
- Agent output (stdout, logs, results) is written to local SQLite only
- The Specter backend runs in Docker on your machine; there is no cloud backend
- The host runner (`specter_host_runner.py`) is a local HTTP server on
  `localhost:8765` — it is not exposed to the network

The only external network calls made during a run are by the agent itself (e.g.
to call an LLM API with your prompt). Those calls go from inside the sandbox
directly to the API provider — your code is not included unless your prompt
explicitly references it. With `deny-all` network policy, even those calls are
blocked.

---

## Security Model

| Property | Detail |
|---|---|
| Isolation | MicroVM hypervisor boundary (not OS-level containers) |
| Filesystem | Only the approved project workspace is mounted — no host home dir, secrets, or other files |
| Docker | Isolated Docker daemon inside sandbox; no access to the host Docker daemon |
| Credentials | `sbx secret` stores API keys outside the sandbox via a local proxy — never sent to Specter |
| Network | Configurable via `sbx policy`; `deny-all` blocks all outbound traffic from the sandbox |
| Recovery | Sandbox deleted after every run; no persistent state left on the host |
| Code & data | Never transmitted to any Specter or Docker server — stays on your machine |

Specter Agent adds its own layer on top:
- Workspace must be explicitly approved before any sandbox run
- All runs are recorded in local SQLite with status, output, and workspace path
- Approval gates in the workflow graph are enforced before task dispatch

---

## Key Files

| File | Role |
|---|---|
| `scripts/specter_host_runner.py` | `_SANDBOX_AGENTS`, `docker_sandbox_status()`, `run_sandbox_agent_task()`, `set_docker_sandbox_policy()`, `safe_sandbox_name()` |
| `backend/app/routers/runtime_adapters.py` | `/docker-sandbox/status` and `/docker-sandbox/policy` routes |
| `src/pages/Models.tsx` | Status card, agent selector, install dialog, policy selector |
| `src/lib/api.ts` | `dockerSandboxRuntimeStatus()`, `dockerSandboxPolicy()`, `setDockerSandboxPolicy()` |

---

## Supported Agents

Specter Agent supports three sandbox agents, selectable per workflow node or test run:

| Agent key | Template | Auth command |
|---|---|---|
| `codex` | `docker/sandbox-templates:codex` | `sbx secret set -g openai --oauth` |
| `claude` | `docker/sandbox-templates:claude-code` | `sbx secret set -g anthropic` |
| `cursor` | `docker/sandbox-templates:cursor` | `sbx secret set -g cursor` |

The agent is set via `"agent": "codex" | "claude" | "cursor"` on each workflow
node (`data.agent` field in the graph JSON). The host runner selects the correct
template and run command from `_SANDBOX_AGENTS`. The Models page exposes an agent
selector that persists to `localStorage` and is sent with each test run.

To use a specific agent in a workflow, set the `agent` field on any
`specialistAgent` node in the workflow builder.
