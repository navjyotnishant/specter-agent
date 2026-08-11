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

## Install

One binary, no interpreter and no runtime dependency:

```bash
curl -fsSL https://raw.githubusercontent.com/navjyotnishant/specter-agent/main/install.sh | sh
```

The installer verifies the published SHA-256 checksum before putting anything on
your PATH, and refuses to install if it does not match. `SPECTER_INSTALL_DIR`
chooses where the binary lands; `SPECTER_VERSION` pins a release.

```bash
specter          # what this machine can do right now
specter serve    # the API and web UI
```

`git`, `gh` and the agent CLIs are **not** bundled — they carry your own
credentials. `specter status` reports which are missing and what each enables.

## Architecture Notes

- [Local Agent Runtime](../guides/codex-cli-host-runner.md): how a workflow node
  reaches an agent, and what stands between that agent and the rest of your
  filesystem.

Agents run on your machine with your own CLIs and credentials. There is no
separate host-runner process to start — `specter serve` spawns agents itself.

## Terminal Workflow Gate

Specter workflows can be run from another project's terminal as a local release
gate, from agent instructions, or from a project script:

```bash
specter run security-review-team --repo .
```

The run executes in that process — no server to reach and no run id to poll —
and its exit code carries the verdict, so a failing workflow blocks a commit
without the caller parsing anything. The same run appears in the web UI while it
happens, because the CLI and the app share one database.

Automation can request machine-readable output:

```bash
specter run security-review-team --repo . --json
```

Colour is emitted only when attached to a terminal and `NO_COLOR` is honoured,
so piped output is plain without a flag.

The repository must be an approved workspace, or the run is refused before any
agent is spawned.

Exit code `0` means the workflow completed successfully. A non-zero exit means
the workflow failed, was cancelled, timed out, hit an approval/policy stop, or
could not be started. The repository path must already be approved in Specter
Agent before the command can run.
