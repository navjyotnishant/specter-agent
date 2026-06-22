#!/usr/bin/env python3
"""
Primary author: Navjyot Nishant
Created on: 2026-06-20
Last updated: 2026-06-20 20:35 CDT
Description: Local Specter Agent CLI for triggering and observing workflow runs from a terminal.
AI usage: Built with assistance from AI tools for implementation acceleration, review, and refactoring.
"""
from __future__ import annotations

import argparse
import getpass
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

DEFAULT_API_BASE = "http://127.0.0.1:8000/api"
ACTIVE_STATUSES = {"queued", "running", "waiting_approval"}
SUCCESS_STATUSES = {"completed"}
FAILURE_STATUSES = {"failed", "cancelled"}

EXIT_SUCCESS = 0
EXIT_WORKFLOW_FAILED = 1
EXIT_API_UNAVAILABLE = 3
EXIT_AUTH_REQUIRED = 4
EXIT_WORKSPACE_NOT_APPROVED = 5
EXIT_NOT_FOUND = 6
EXIT_TIMEOUT = 124


class SpecterCliError(Exception):
    def __init__(self, message: str, exit_code: int = 1) -> None:
        super().__init__(message)
        self.exit_code = exit_code


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or value.lower()


def resolve_path(path: str) -> str:
    return str(Path(path).expanduser().resolve())


def web_base_from_api(api_base: str) -> str:
    if api_base.rstrip("/").endswith("/api"):
        return api_base.rstrip("/")[:-4]
    return api_base.rstrip("/")


class SpecterClient:
    def __init__(self, api_base: str, token: str | None) -> None:
        self.api_base = api_base.rstrip("/")
        self.token = token

    def request(self, method: str, path: str, body: dict[str, Any] | None = None, auth: bool = True) -> Any:
        payload = json.dumps(body).encode("utf-8") if body is not None else None
        request = urllib.request.Request(f"{self.api_base}{path}", data=payload, method=method)
        request.add_header("Accept", "application/json")
        if body is not None:
            request.add_header("Content-Type", "application/json")
        if auth:
            if not self.token:
                raise SpecterCliError(
                    "Specter token required. Set SPECTER_TOKEN or run `scripts/specter_cli.py auth login`.",
                    EXIT_AUTH_REQUIRED,
                )
            request.add_header("Authorization", f"Bearer {self.token}")
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                raw = response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            try:
                parsed = json.loads(detail)
                detail = str(parsed.get("detail") or parsed)
            except json.JSONDecodeError:
                pass
            if exc.code in {401, 403}:
                raise SpecterCliError(f"Authentication failed: {detail}", EXIT_AUTH_REQUIRED)
            if exc.code == 404:
                raise SpecterCliError(detail or "Resource not found.", EXIT_NOT_FOUND)
            raise SpecterCliError(f"Specter API error {exc.code}: {detail}")
        except urllib.error.URLError as exc:
            raise SpecterCliError(f"Specter API unavailable at {self.api_base}: {exc.reason}", EXIT_API_UNAVAILABLE)
        if not raw:
            return {}
        return json.loads(raw)

    def login(self, email: str, password: str) -> dict[str, Any]:
        return self.request("POST", "/auth/login", {"email": email, "password": password}, auth=False)

    def list_workflows(self) -> list[dict[str, Any]]:
        return self.request("GET", "/workflows")

    def list_workspaces(self) -> list[dict[str, Any]]:
        return self.request("GET", "/runtime-adapters/workspaces")

    def start_run(self, workflow_id: str, workspace_path: str) -> dict[str, Any]:
        return self.request("POST", "/workflow-runs", {"workflow_id": workflow_id, "workspace_path": workspace_path})

    def get_run(self, run_id: str) -> dict[str, Any]:
        return self.request("GET", f"/workflow-runs/{run_id}")

    def get_logs(self, run_id: str) -> list[dict[str, Any]]:
        return self.request("GET", f"/workflow-runs/{run_id}/logs")

    def get_approvals(self, run_id: str) -> list[dict[str, Any]]:
        return self.request("GET", f"/workflow-runs/{run_id}/approvals")

    def codex_runtime_status(self) -> dict[str, Any]:
        return self.request("GET", "/runtime-adapters/codex-cli/status")


def resolve_workflow(client: SpecterClient, selector: str) -> dict[str, Any]:
    workflows = client.list_workflows()
    selector_slug = slugify(selector)
    matches = [
        workflow
        for workflow in workflows
        if workflow.get("id") == selector
        or str(workflow.get("name") or "").lower() == selector.lower()
        or slugify(str(workflow.get("name") or "")) == selector_slug
    ]
    if not matches:
        raise SpecterCliError(f"Workflow not found: {selector}", EXIT_NOT_FOUND)
    if len(matches) > 1:
        names = ", ".join(f"{workflow.get('name')} ({workflow.get('id')})" for workflow in matches)
        raise SpecterCliError(f"Workflow selector is ambiguous: {selector}. Matches: {names}", EXIT_NOT_FOUND)
    return matches[0]


def resolve_approved_workspace(client: SpecterClient, requested_path: str) -> dict[str, Any]:
    resolved = Path(resolve_path(requested_path))
    workspaces = [workspace for workspace in client.list_workspaces() if workspace.get("is_active")]
    candidates: list[tuple[int, dict[str, Any]]] = []
    for workspace in workspaces:
        workspace_path = Path(resolve_path(str(workspace.get("path") or "")))
        if resolved == workspace_path or workspace_path in resolved.parents:
            candidates.append((len(workspace_path.parts), workspace))
    if not candidates:
        raise SpecterCliError(
            f"Workspace is not approved in Specter Agent: {resolved}\n"
            "Approve the repository in Settings > Models > Approved repositories, then retry.",
            EXIT_WORKSPACE_NOT_APPROVED,
        )
    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[0][1]


def ensure_runtime_ready(client: SpecterClient) -> None:
    status = client.codex_runtime_status()
    runtime_status = str(status.get("status") or "")
    if runtime_status == "ready":
        return

    message = str(status.get("message") or "Specter local execution runtime is not ready.")
    diagnostic = str(status.get("diagnostic") or "").strip()
    install_hint = ""
    if runtime_status == "host_runner_unavailable":
        install_hint = "\nStart it from the Specter Agent repository: python3 scripts/specter_host_runner.py"
    elif runtime_status == "missing":
        install_hint = "\nInstall Codex CLI from the Specter Models page, then sign in from your terminal."
    elif runtime_status in {"not_authenticated", "auth_required"}:
        install_hint = "\nRun `codex` in your terminal and complete sign-in, then retry."

    details = f"\nDiagnostic: {diagnostic}" if diagnostic else ""
    raise SpecterCliError(
        f"Specter runtime is not ready: {message}{install_hint}{details}",
        EXIT_API_UNAVAILABLE,
    )


def workflow_url(web_base: str, workflow_id: str, run_id: str) -> str:
    return f"{web_base.rstrip('/')}/workflows/{workflow_id}/run/{run_id}"


def print_json(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, indent=2, sort_keys=True))


def emit_log_line(log: dict[str, Any], stream=sys.stdout) -> None:
    level = str(log.get("level") or "info").upper()
    message = str(log.get("message") or "")
    created_at = str(log.get("created_at") or "")
    prefix = f"[{created_at}] " if created_at else ""
    print(f"{prefix}{level}: {message}", file=stream)


def wait_for_run(
    client: SpecterClient,
    run_id: str,
    workflow: dict[str, Any],
    web_base: str,
    poll_interval: float,
    timeout_seconds: int,
    json_output: bool,
    quiet: bool,
) -> int:
    start = time.monotonic()
    seen_logs: set[str] = set()
    last_approval_ids: set[str] = set()
    final_run: dict[str, Any] | None = None
    progress_stream = sys.stderr if json_output else sys.stdout

    while True:
        if timeout_seconds > 0 and time.monotonic() - start > timeout_seconds:
            result = {
                "ok": False,
                "status": "timeout",
                "run_id": run_id,
                "workflow_id": workflow["id"],
                "workflow_name": workflow["name"],
                "url": workflow_url(web_base, workflow["id"], run_id),
            }
            if json_output:
                print_json(result)
            else:
                print(f"Timed out waiting for workflow run: {run_id}", file=sys.stderr)
            return EXIT_TIMEOUT

        run = client.get_run(run_id)
        final_run = run
        if not quiet:
            for log in client.get_logs(run_id):
                log_id = str(log.get("id") or "")
                if log_id and log_id not in seen_logs:
                    seen_logs.add(log_id)
                    emit_log_line(log, stream=progress_stream)
            approvals = [approval for approval in client.get_approvals(run_id) if approval.get("status") == "pending"]
            approval_ids = {str(approval.get("id")) for approval in approvals}
            for approval in approvals:
                approval_id = str(approval.get("id"))
                if approval_id not in last_approval_ids:
                    expires_at = approval.get("expires_at") or "deadline not recorded"
                    print(f"WAITING APPROVAL: {approval.get('title')} expires at {expires_at}", file=progress_stream)
            last_approval_ids = approval_ids

        status = str(run.get("status") or "")
        if status not in ACTIVE_STATUSES:
            break
        time.sleep(poll_interval)

    status = str((final_run or {}).get("status") or "unknown")
    ok = status in SUCCESS_STATUSES
    result = {
        "ok": ok,
        "status": status,
        "run_id": run_id,
        "workflow_id": workflow["id"],
        "workflow_name": workflow["name"],
        "url": workflow_url(web_base, workflow["id"], run_id),
        "created_at": (final_run or {}).get("created_at"),
        "completed_at": (final_run or {}).get("completed_at"),
    }
    if json_output:
        print_json(result)
    else:
        verdict = "PASS" if ok else "FAIL"
        print(f"{verdict}: workflow run {run_id} finished with status `{status}`")
        print(f"Evidence: {result['url']}")
    return EXIT_SUCCESS if ok else EXIT_WORKFLOW_FAILED


def cmd_auth_login(args: argparse.Namespace) -> int:
    client = SpecterClient(args.api_base, token=None)
    password = args.password or getpass.getpass("Specter password: ")
    response = client.login(args.email, password)
    token = response.get("token")
    if args.json:
        print_json({"ok": True, "token": token, "user": response.get("user")})
    else:
        print("Login successful.")
        print(f"export SPECTER_TOKEN='{token}'")
    return EXIT_SUCCESS


def cmd_workflow_list(args: argparse.Namespace) -> int:
    client = SpecterClient(args.api_base, args.token)
    workflows = client.list_workflows()
    if args.json:
        print_json({"workflows": workflows})
        return EXIT_SUCCESS
    for workflow in workflows:
        marker = "template" if workflow.get("is_template") else "workflow"
        print(f"{workflow.get('id')}\t{slugify(str(workflow.get('name') or ''))}\t{marker}\t{workflow.get('name')}")
    return EXIT_SUCCESS


def cmd_workflow_run(args: argparse.Namespace) -> int:
    client = SpecterClient(args.api_base, args.token)
    workflow = resolve_workflow(client, args.workflow)
    workspace = resolve_approved_workspace(client, args.workspace)
    ensure_runtime_ready(client)
    workspace_path = str(workspace["path"])
    response = client.start_run(str(workflow["id"]), workspace_path)
    run_id = str(response["run_id"])
    result = {
        "ok": True,
        "status": response.get("status"),
        "run_id": run_id,
        "workflow_id": workflow["id"],
        "workflow_name": workflow["name"],
        "workspace_path": workspace_path,
        "url": workflow_url(args.web_base, workflow["id"], run_id),
    }
    if not args.wait:
        if args.json:
            print_json(result)
        else:
            print(f"Started workflow run: {run_id}")
            print(f"Evidence: {result['url']}")
        return EXIT_SUCCESS

    if not args.json:
        print(f"Started workflow run: {run_id}")
        print(f"Workflow: {workflow['name']}")
        print(f"Workspace: {workspace_path}")
        print(f"Evidence: {result['url']}")
    elif not args.quiet:
        print(f"Started workflow run: {run_id}", file=sys.stderr)
        print(f"Workflow: {workflow['name']}", file=sys.stderr)
        print(f"Workspace: {workspace_path}", file=sys.stderr)
        print(f"Evidence: {result['url']}", file=sys.stderr)
    return wait_for_run(client, run_id, workflow, args.web_base, args.poll_interval, args.timeout, args.json, args.quiet)


def cmd_workflow_status(args: argparse.Namespace) -> int:
    client = SpecterClient(args.api_base, args.token)
    run = client.get_run(args.run_id)
    result = {
        "run": run,
        "url": workflow_url(args.web_base, str(run["workflow_id"]), args.run_id),
    }
    if args.json:
        print_json(result)
    else:
        print(f"{args.run_id}\t{run.get('status')}\t{result['url']}")
    return EXIT_SUCCESS if run.get("status") in SUCCESS_STATUSES else EXIT_WORKFLOW_FAILED if run.get("status") in FAILURE_STATUSES else EXIT_SUCCESS


def cmd_workflow_logs(args: argparse.Namespace) -> int:
    client = SpecterClient(args.api_base, args.token)
    seen_logs: set[str] = set()
    while True:
        run = client.get_run(args.run_id)
        logs = client.get_logs(args.run_id)
        for log in logs:
            log_id = str(log.get("id") or "")
            if args.follow and log_id in seen_logs:
                continue
            if log_id:
                seen_logs.add(log_id)
            if args.json:
                print(json.dumps(log, sort_keys=True))
            else:
                emit_log_line(log)
        if not args.follow or str(run.get("status")) not in ACTIVE_STATUSES:
            break
        time.sleep(args.poll_interval)
    return EXIT_SUCCESS


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="specter", description="Local Specter Agent terminal workflow client.")
    parser.add_argument("--api-base", default=os.environ.get("SPECTER_API_BASE_URL", DEFAULT_API_BASE), help="Specter API base URL.")
    parser.add_argument("--web-base", default=os.environ.get("SPECTER_WEB_BASE_URL"), help="Specter web base URL for evidence links.")
    parser.add_argument("--token", default=os.environ.get("SPECTER_TOKEN"), help="Specter bearer token. Defaults to SPECTER_TOKEN.")
    parser.set_defaults(func=None)

    subcommands = parser.add_subparsers(dest="command")

    auth = subcommands.add_parser("auth", help="Authentication helpers.")
    auth_subcommands = auth.add_subparsers(dest="auth_command")
    login = auth_subcommands.add_parser("login", help="Log in and print a bearer token export command.")
    login.add_argument("--email", required=True)
    login.add_argument("--password", help="Password. If omitted, prompts securely.")
    login.add_argument("--json", action="store_true")
    login.set_defaults(func=cmd_auth_login)

    workflow = subcommands.add_parser("workflow", help="Workflow commands.")
    workflow_subcommands = workflow.add_subparsers(dest="workflow_command")

    workflow_list = workflow_subcommands.add_parser("list", help="List workflows.")
    workflow_list.add_argument("--json", action="store_true")
    workflow_list.set_defaults(func=cmd_workflow_list)

    workflow_run = workflow_subcommands.add_parser("run", help="Start a workflow run.")
    workflow_run.add_argument("workflow", help="Workflow id, name, or slug.")
    workflow_run.add_argument("--workspace", default=".", help="Repository path to map to an approved Specter workspace.")
    workflow_run.add_argument("--wait", action="store_true", help="Wait for completion and return pass/fail exit code.")
    workflow_run.add_argument("--json", action="store_true", help="Print machine-readable final JSON.")
    workflow_run.add_argument("--quiet", action="store_true", help="Suppress live progress output while waiting.")
    workflow_run.add_argument("--poll-interval", type=float, default=3.0, help="Polling interval while waiting.")
    workflow_run.add_argument("--timeout", type=int, default=0, help="Maximum seconds to wait. 0 means no CLI wait timeout.")
    workflow_run.set_defaults(func=cmd_workflow_run)

    workflow_status = workflow_subcommands.add_parser("status", help="Show workflow run status.")
    workflow_status.add_argument("run_id")
    workflow_status.add_argument("--json", action="store_true")
    workflow_status.set_defaults(func=cmd_workflow_status)

    workflow_logs = workflow_subcommands.add_parser("logs", help="Print workflow run logs.")
    workflow_logs.add_argument("run_id")
    workflow_logs.add_argument("--follow", action="store_true")
    workflow_logs.add_argument("--json", action="store_true")
    workflow_logs.add_argument("--poll-interval", type=float, default=3.0)
    workflow_logs.set_defaults(func=cmd_workflow_logs)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    args.web_base = (args.web_base or web_base_from_api(args.api_base)).rstrip("/")
    if args.func is None:
        parser.print_help()
        return 2
    try:
        return int(args.func(args))
    except SpecterCliError as exc:
        print(str(exc), file=sys.stderr)
        return exc.exit_code


if __name__ == "__main__":
    raise SystemExit(main())
