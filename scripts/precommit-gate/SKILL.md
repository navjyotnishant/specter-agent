---
name: specter-precommit-gate
description: Use this skill before committing changes in a repository that has a Specter pre-commit workflow configured, or when explicitly asked to run the Specter pre-commit gate. Runs a Specter workflow against the current repo and blocks the commit if the workflow fails.
---

# Specter pre-commit gate

Runs a Specter workflow (a security or lint review, say) against the current
repository and reports pass/fail — intended to run right before committing.

## How this works now

`specter run` executes the workflow **in its own process**: no server to reach,
no daemon to keep alive, no run id to poll. It blocks until the run reaches a
terminal state and carries the verdict in its exit code.

That replaces the HTTP polling loop this skill used to describe. The loop existed
only because the previous CLI could be scheduled in the background by a tool-use
layer instead of blocking; a single synchronous command has no such failure mode.

## Required setup (once per repo)

- `SPECTER_WORKFLOW` — the workflow's name or id (built in the web UI's Workflow
  Builder, or one of the seeded templates).
- `SPECTER_BIN` — optional, the path to the binary if `specter` is not on PATH.
- `SPECTER_HOME` — optional, the state directory. It must match whatever the rest
  of the install uses: it relocates the database, so a mismatch means the gate
  reads a different database and reports that the workflow does not exist.

No token and no API base URL. The binary reads the database directly, so there is
nothing to authenticate against.

The repository must be registered as an **approved workspace** (Connectors /
Workspaces in the web UI). An unapproved path is refused before any agent is
spawned — that is what the allowlist is for, and the gate must not work around it.

## Steps

1. **Run the gate.** From the repository root:

   ```bash
   specter run "$SPECTER_WORKFLOW" --repo .
   ```

   Add `--json` when the result is to be parsed rather than read.

2. **Read the exit code.**
   - `0` → the gate passed. Proceed with the commit.
   - non-zero → the gate failed. **Do not commit.** Summarize which node failed
     and why, from the output, rather than reporting a bare "failed".

An approval gate in the workflow suspends the run until a human resolves it in
the web UI. Say so rather than waiting silently — a hook that appears to hang is
indistinguishable from one that is broken.

## Worked example

```console
$ specter run "Security Review Team" --repo .

  Security Review Team                        1m 04s
  ├─ ✓ Code Security         completed            8s
  ├─ ✓ Dependency Risk       completed           12s
  ├─ ✓ Secrets & Config      completed            9s
  └─ ✗ Report Writer         failed              31s

  failed · 42284fac-76a1-447c-8256-d505caf47fa2

$ echo $?
1
```

→ gate failed, do not commit. Report the failing node (`Report Writer`) and what
its output said, not just the status.

The same run is visible in the web UI while it happens — the CLI and the app
write to and read from one database, so there is nothing to sync.
