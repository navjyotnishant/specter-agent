"""
Primary author: Navjyot Nishant
Created on: 2026-06-20
Description: Best-effort Linear issue logging for workflow run failures and completions.
             All calls are fire-and-forget; exceptions are caught and written to run_logs
             so they never block or crash a workflow run.
AI usage: Built with assistance from AI tools for implementation acceleration, review, and refactoring.
"""
from __future__ import annotations

import json
import urllib.request
import urllib.error
from datetime import datetime, timezone

from app.core.config import get_settings


_LINEAR_URL = "https://api.linear.app/graphql"


def _gql(token: str, query: str, variables: dict) -> dict:
    payload = json.dumps({"query": query, "variables": variables}).encode()
    req = urllib.request.Request(_LINEAR_URL, data=payload, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", token)
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


def _resolve_team_id(token: str, team_key_or_id: str) -> str | None:
    """Return the UUID for a team given its key (e.g. 'SPE') or UUID."""
    q = """
    query Teams {
      teams { nodes { id key } }
    }
    """
    data = _gql(token, q, {})
    for team in data.get("data", {}).get("teams", {}).get("nodes", []):
        if team["key"] == team_key_or_id or team["id"] == team_key_or_id:
            return team["id"]
    return None


def _resolve_project_id(token: str, team_id: str, project_name: str) -> str | None:
    q = """
    query Projects($teamId: String!) {
      team(id: $teamId) { projects { nodes { id name } } }
    }
    """
    data = _gql(token, q, {"teamId": team_id})
    for proj in data.get("data", {}).get("team", {}).get("projects", {}).get("nodes", []):
        if proj["name"].lower() == project_name.lower():
            return proj["id"]
    return None


def _find_open_failure_issue(token: str, team_id: str, workflow_name: str) -> str | None:
    """Return the ID of an existing open run-failure issue for this workflow, if any."""
    prefix = f"[Run failure] {workflow_name}"
    q = """
    query SearchIssues($filter: IssueFilter!) {
      issues(filter: $filter, first: 5) {
        nodes { id title state { type } }
      }
    }
    """
    variables = {
        "filter": {
            "team": {"id": {"eq": team_id}},
            "title": {"startsWith": prefix},
            "state": {"type": {"neq": "completed"}},
        }
    }
    data = _gql(token, q, variables)
    nodes = data.get("data", {}).get("issues", {}).get("nodes", [])
    return nodes[0]["id"] if nodes else None


def _create_issue(token: str, team_id: str, project_id: str | None, title: str, description: str, priority: int) -> str | None:
    q = """
    mutation CreateIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) { issue { id url } }
    }
    """
    inp: dict = {
        "teamId": team_id,
        "title": title,
        "description": description,
        "priority": priority,
        "stateId": None,  # will use team default "In Progress"
    }
    if project_id:
        inp["projectId"] = project_id
    # remove None values
    inp = {k: v for k, v in inp.items() if v is not None}
    data = _gql(token, q, {"input": inp})
    return data.get("data", {}).get("issueCreate", {}).get("issue", {}).get("url")


def _add_comment(token: str, issue_id: str, body: str) -> None:
    q = """
    mutation AddComment($input: CommentCreateInput!) {
      commentCreate(input: $input) { success }
    }
    """
    _gql(token, q, {"input": {"issueId": issue_id, "body": body}})


# ── public API ────────────────────────────────────────────────────────────────

def log_run_failure(
    run_id: str,
    workflow_name: str,
    node_label: str,
    error: str,
    workspace_path: str = "",
) -> str | None:
    """
    Create a Linear issue for a workflow run failure.
    Returns the issue URL, or None if Linear is not configured or the call failed.
    All exceptions are swallowed — this must never crash a workflow run.
    """
    settings = get_settings()
    if not settings.linear_api_token:
        return None
    try:
        token = settings.linear_api_token
        team_id = _resolve_team_id(token, settings.linear_team_id)
        if not team_id:
            return None
        project_id = _resolve_project_id(token, team_id, settings.linear_project_name)
        date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        run_short = run_id[:8]
        title = f"[Run failure] {workflow_name} — {run_short} — {date_str}"
        description = (
            f"## Workflow run failed\n\n"
            f"| Field | Value |\n"
            f"|---|---|\n"
            f"| Workflow | `{workflow_name}` |\n"
            f"| Run ID | `{run_id}` |\n"
            f"| Failed node | `{node_label}` |\n"
            f"| Workspace | `{workspace_path or 'n/a'}` |\n"
            f"| Date | {date_str} |\n\n"
            f"### Error\n\n```\n{error[:2000]}\n```\n"
        )
        return _create_issue(token, team_id, project_id, title, description, priority=2)
    except Exception:
        return None


def log_run_complete(run_id: str, workflow_name: str) -> None:
    """
    If an open failure issue exists for this workflow, comment that it completed successfully.
    All exceptions are swallowed.
    """
    settings = get_settings()
    if not settings.linear_api_token:
        return
    try:
        token = settings.linear_api_token
        team_id = _resolve_team_id(token, settings.linear_team_id)
        if not team_id:
            return
        issue_id = _find_open_failure_issue(token, team_id, workflow_name)
        if not issue_id:
            return
        date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        _add_comment(
            token,
            issue_id,
            f"✅ Workflow **{workflow_name}** completed successfully on {date_str} (run `{run_id[:8]}`).\n\nMonitor for recurrence — close this issue if the failure no longer reproduces.",
        )
    except Exception:
        return
