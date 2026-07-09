---
name: specter-precommit-gate
description: Use this skill before committing changes in a repository that has a Specter Agent pre-commit workflow configured, or when explicitly asked to run the Specter pre-commit gate. Runs a Specter Agent workflow against the current repo and blocks the commit if the workflow fails. Do not use scripts/specter-agent or specter_cli.py directly for this — those are long-blocking CLI calls that may be scheduled in the background by the tool-use layer instead of blocking; this skill uses short, synchronous HTTP calls instead.
---

# Specter pre-commit gate

Runs a Specter Agent workflow (e.g. a security or lint review) against the current
repository and reports pass/fail — intended to run right before committing.

## Required setup (once per repo)

These environment variables must be set (e.g. in the user's shell profile, or a
local `.env` sourced by the shell — never commit tokens to source control):

- `SPECTER_API_BASE_URL` — e.g. `http://127.0.0.1:8000/api` (defaults to that if unset)
- `SPECTER_TOKEN` — a Specter bearer token (obtain via `scripts/specter_cli.py auth login`,
  which prints an `export SPECTER_TOKEN=...` line)
- `SPECTER_WORKFLOW_ID` — the id, exact name, or slug of the workflow to run (built
  in the Specter web UI's Workflow Builder)

The repository's path must already be registered as an **approved workspace** in
Specter (Connectors / Workspaces page in the web UI) — Specter rejects run requests
for any path that isn't on that allowlist.

## Steps

Perform each step as its own tool call. Do NOT combine steps 1–2 into a single
shell script or background process — the whole point of this skill is to stay
synchronous, which only works if each HTTP call is issued and awaited individually.

1. **Start the run.** POST to `{SPECTER_API_BASE_URL}/workflow-runs` with:
   - Header: `Authorization: Bearer {SPECTER_TOKEN}`
   - JSON body: `{"workflow_id": "{SPECTER_WORKFLOW_ID}", "workspace_path": "<absolute path to the current repo root>"}`
   - Save the `run_id` from the response. Initial `status` will be `"queued"`.

2. **Poll for completion.** Every ~3 seconds, GET
   `{SPECTER_API_BASE_URL}/workflow-runs/{run_id}` (same auth header).
   Check the `status` field. Keep polling while it is `"queued"`, `"running"`,
   or `"waiting_approval"`. Stop when it becomes `"completed"`, `"failed"`, or
   `"cancelled"`. If `"waiting_approval"`, tell the user a human approval is
   pending in the Specter web UI and pause — do not keep polling indefinitely
   without telling the user why it's taking a while.

3. **Report the result.**
   - `"completed"` → the gate passed. Tell the user and proceed with the commit.
   - `"failed"` or `"cancelled"` → the gate failed. **Do not commit.** Fetch
     `GET {SPECTER_API_BASE_URL}/workflow-runs/{run_id}/logs` and summarize the
     failure for the user, along with the run URL if `SPECTER_WEB_BASE_URL` is
     known (`{SPECTER_WEB_BASE_URL}/workflows/{workflow_id}/run/{run_id}`).

## Example (illustrative — issue these as separate calls, not one script)

```
POST {SPECTER_API_BASE_URL}/workflow-runs
  Authorization: Bearer sk_live_...
  {"workflow_id": "security-review-team", "workspace_path": "/Users/me/projects/my-app"}
  → {"run_id": "abc123", "status": "queued", ...}

GET {SPECTER_API_BASE_URL}/workflow-runs/abc123
  → {"status": "running", ...}          (poll again in ~3s)
  → {"status": "completed", ...}        (done — safe to commit)
```
