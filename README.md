# Specter Agent

Enterprise-grade agent orchestration for governed software delivery workflows.

## Overview

Specter Agent helps teams design, operate, approve, and audit multi-agent
delivery workflows from a single workspace. Supervisors coordinate specialist
agents, approvals keep sensitive actions controlled, and run evidence remains
available for review.

## Local Operations

Runtime state is host-mounted so rebuilding or recreating the app does not wipe
local work:

| Host path | Container path | Purpose |
|---|---|---|
| `./data` | `/app/data` | Application data |
| `./artifacts` | `/app/artifacts` | Generated reports and run artifacts |
| `./secrets` | `/app/secrets` | Local secret/config files |
| `./codebases` | `/app/codebases` | Read-only mounted repositories for review |

Start the app with:

```bash
mkdir -p data artifacts secrets codebases
docker compose up -d --build
```

You can rebuild safely with `docker compose up -d --build`; application data
remains under `./data`. To intentionally reset local state, stop the app and
delete the relevant host files.

## Architecture Notes

- [Codex CLI Host Runner](docs/codex-cli-host-runner.md): local runtime boundary
  for using a user's authenticated Codex CLI without storing Codex credentials
  inside Specter Agent.

Run the host runner outside Docker when local runtimes need host access:

```bash
python3 scripts/specter_host_runner.py
```

To allow UI-approved Codex CLI install and upgrade actions during setup:

```bash
SPECTER_HOST_RUNNER_ENABLE_INSTALL=1 python3 scripts/specter_host_runner.py
```
