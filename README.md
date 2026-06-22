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

Before starting Specter Agent, check the host prerequisites:

```bash
python3 scripts/check_prerequisites.py
```

The checker reports missing Docker, Docker Compose, Docker Sandboxes, daemon,
authentication, and host-runner prerequisites with exact remediation commands.
Use JSON output when another installer or app flow needs to consume the result:

```bash
python3 scripts/check_prerequisites.py --json
```

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

## Terminal Workflow Gate

Specter workflows can be triggered from another project terminal for local
release gates, agent instructions, or project scripts. Use the wrapper for the
simple path:

```bash
scripts/specter_gate.py security-review-team --workspace .
```

The wrapper prompts for Specter login when needed, caches the local token under
`~/.specter-agent/token.json` with user-only permissions, then starts the
workflow and waits for the pass/fail result.

Automation can request final JSON and use the process exit code:

```bash
scripts/specter_gate.py security-review-team --workspace . --json
```

Exit code `0` means the workflow completed successfully. A non-zero exit means
the workflow failed, was cancelled, timed out, hit an approval/policy stop, or
could not be started. The repository path must already be approved in Specter
Agent before the command can run.
