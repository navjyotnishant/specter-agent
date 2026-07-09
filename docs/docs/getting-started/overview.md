---
id: overview
title: Overview
sidebar_position: 1
slug: /
---

# Specter Agent

Enterprise-grade agent orchestration for governed software delivery workflows.

## Overview

Specter Agent helps teams design, operate, approve, and audit multi-agent
delivery workflows from a single workspace. Supervisors coordinate specialist
agents, approvals keep sensitive actions controlled, and run evidence remains
available for review.

## Architecture Notes

- [Local Agent Runtime Architecture](../guides/codex-cli-host-runner.md): local
  runtime boundary for using a user's authenticated Codex CLI without storing
  Codex credentials inside Specter Agent.

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
scripts/specter-agent security-review-team --workspace .
```

The wrapper prompts for Specter login when needed, caches the local token under
`~/.specter-agent/token.json` with user-only permissions, then starts the
workflow and waits for the pass/fail result.

Automation can request final JSON and use the process exit code:

```bash
scripts/specter-agent security-review-team --workspace . --json
```

With `--json`, color-coded live progress is written to stderr while the final
machine-readable result stays on stdout. Use `--quiet` to suppress progress in
strict CI scripts, or `--no-color` to disable ANSI color.

Exit code `0` means the workflow completed successfully. A non-zero exit means
the workflow failed, was cancelled, timed out, hit an approval/policy stop, or
could not be started. The repository path must already be approved in Specter
Agent before the command can run.
