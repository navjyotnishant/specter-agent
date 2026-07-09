# Workflow graph runner.
# Walks nodes level-by-level in topological order; nodes at the same depth can run
# in parallel (per the supervisor's delegation strategy). Executes each node via the
# host runner CLIs (Codex, Claude Code, Cursor) and writes events to the DB.
from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

from app.core.config import get_settings
from app.db.session import db_session
from app.runtime import linear_logger

DEFAULT_APPROVAL_TIMEOUT_HOURS = 24
MIN_APPROVAL_TIMEOUT_HOURS = 1
MAX_APPROVAL_TIMEOUT_HOURS = 24 * 30
_ACTIVE_RUNS: dict[str, threading.Thread] = {}
_ACTIVE_RUNS_LOCK = threading.Lock()


# ── topology ──────────────────────────────────────────────────────────────────

def topological_order(nodes: list[dict], edges: list[dict]) -> list[dict]:
    """Return nodes in topological order (Kahn's algorithm). Falls back to node list order."""
    id_to_node = {n["id"]: n for n in nodes}
    in_degree: dict[str, int] = {n["id"]: 0 for n in nodes}
    adjacency: dict[str, list[str]] = {n["id"]: [] for n in nodes}

    for edge in edges:
        src, tgt = edge.get("source"), edge.get("target")
        if src in adjacency and tgt in in_degree:
            adjacency[src].append(tgt)
            in_degree[tgt] += 1

    queue = [nid for nid, deg in in_degree.items() if deg == 0]
    order: list[dict] = []
    while queue:
        nid = queue.pop(0)
        if nid in id_to_node:
            order.append(id_to_node[nid])
        for neighbor in adjacency.get(nid, []):
            in_degree[neighbor] -= 1
            if in_degree[neighbor] == 0:
                queue.append(neighbor)

    # include any disconnected nodes not reached
    seen = {n["id"] for n in order}
    for node in nodes:
        if node["id"] not in seen:
            order.append(node)

    return order


def topological_levels(nodes: list[dict], edges: list[dict]) -> list[list[dict]]:
    """Group nodes into topological depth levels (depth = max parent depth + 1).

    Nodes in the same level have no dependencies between them and may run in
    parallel. humanApproval nodes are split into their own singleton levels so
    the sequential approval/resume machinery stays untouched.
    """
    ordered = topological_order(nodes, edges)
    parents: dict[str, list[str]] = {n["id"]: [] for n in nodes}
    for edge in edges:
        src, tgt = edge.get("source"), edge.get("target")
        if src in parents and tgt in parents:
            parents[tgt].append(src)

    depth: dict[str, int] = {}
    for node in ordered:
        parent_depths = [depth.get(p, 0) for p in parents[node["id"]]]
        depth[node["id"]] = (max(parent_depths) + 1) if parent_depths else 0

    max_depth = max(depth.values(), default=0)
    levels: list[list[dict]] = [[] for _ in range(max_depth + 1)]
    for node in ordered:
        levels[depth[node["id"]]].append(node)

    # split approval gates into their own levels
    result: list[list[dict]] = []
    for level in levels:
        agents = [n for n in level if n.get("type") != "humanApproval"]
        approvals = [n for n in level if n.get("type") == "humanApproval"]
        if agents:
            result.append(agents)
        for approval in approvals:
            result.append([approval])
    return result


# ── DB helpers ────────────────────────────────────────────────────────────────

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _approval_timeout_hours(node: dict) -> int:
    data = node.get("data") or {}
    raw = data.get("timeoutHours", DEFAULT_APPROVAL_TIMEOUT_HOURS)
    try:
        hours = int(raw)
    except (TypeError, ValueError):
        hours = DEFAULT_APPROVAL_TIMEOUT_HOURS
    return max(MIN_APPROVAL_TIMEOUT_HOURS, min(MAX_APPROVAL_TIMEOUT_HOURS, hours))


def _write_step(run_id: str, node: dict, status: str, stdout: str = "", stderr: str = "", summary: str = "", error: str | None = None) -> str:
    step_id = str(uuid4())
    data = node.get("data") or {}
    with db_session() as db:
        db.execute(
            """
            INSERT OR REPLACE INTO workflow_step_runs
              (id, workflow_run_id, node_id, node_type, status, started_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (step_id, run_id, node["id"], node.get("type", "unknown"), status, _now()),
        )
        # also write to agent_runs for richer querying
        db.execute(
            """
            INSERT OR REPLACE INTO agent_runs
              (id, workflow_run_id, node_id, agent_name, agent_role, model, status, started_at, summary, error)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                step_id, run_id, node["id"],
                str(data.get("label") or node["id"]),
                str(data.get("role") or node.get("type") or "agent"),
                str(data.get("model") or "codex-cli"),
                status, _now(), summary or None, error,
            ),
        )
        if stdout or stderr:
            db.execute(
                """
                INSERT INTO agent_messages (id, agent_run_id, sender_type, sender_name, content)
                VALUES (?, ?, 'agent', ?, ?)
                """,
                (str(uuid4()), step_id, str(data.get("label") or node["id"]), stdout or stderr),
            )
    return step_id


def _update_step(step_id: str, status: str, stdout: str = "", stderr: str = "", summary: str = "", error: str | None = None) -> None:
    with db_session() as db:
        db.execute(
            "UPDATE workflow_step_runs SET status = ?, completed_at = ? WHERE id = ?",
            (status, _now(), step_id),
        )
        db.execute(
            "UPDATE agent_runs SET status = ?, completed_at = ?, summary = ?, error = ? WHERE id = ?",
            (status, _now(), summary or None, error, step_id),
        )
        if stdout or stderr:
            agent_run = db.execute("SELECT id FROM agent_runs WHERE id = ?", (step_id,)).fetchone()
            if agent_run:
                db.execute(
                    "INSERT INTO agent_messages (id, agent_run_id, sender_type, sender_name, content) VALUES (?, ?, 'agent', 'output', ?)",
                    (str(uuid4()), step_id, (stdout or stderr)[-20000:]),
                )


def _update_run_status(run_id: str, status: str) -> None:
    with db_session() as db:
        completed = _now() if status in ("completed", "failed", "cancelled") else None
        db.execute(
            "UPDATE workflow_runs SET status = ?, completed_at = ? WHERE id = ?",
            (status, completed, run_id),
        )


def _write_log(run_id: str, level: str, message: str, metadata: dict | None = None) -> None:
    with db_session() as db:
        db.execute(
            "INSERT INTO run_logs (id, workflow_run_id, level, message, metadata_json) VALUES (?, ?, ?, ?, ?)",
            (str(uuid4()), run_id, level, message, json.dumps(metadata or {})),
        )


def _latest_step_for_node(run_id: str, node_id: str):
    with db_session() as db:
        return db.execute(
            """
            SELECT ws.*, ar.summary, ar.error
            FROM workflow_step_runs ws
            LEFT JOIN agent_runs ar ON ar.id = ws.id
            WHERE ws.workflow_run_id = ? AND ws.node_id = ?
            ORDER BY ws.started_at DESC
            LIMIT 1
            """,
            (run_id, node_id),
        ).fetchone()


def _approval_for_step(step_id: str):
    with db_session() as db:
        return db.execute(
            "SELECT * FROM approval_requests WHERE workflow_step_run_id = ? ORDER BY created_at DESC LIMIT 1",
            (step_id,),
        ).fetchone()


def _write_approval_request(run_id: str, step_id: str, node: dict) -> str:
    approval_id = str(uuid4())
    data = node.get("data") or {}
    timeout_hours = _approval_timeout_hours(node)
    expires_at = (datetime.now(timezone.utc) + timedelta(hours=timeout_hours)).isoformat()
    with db_session() as db:
        db.execute(
            """
            INSERT INTO approval_requests
              (id, workflow_run_id, workflow_step_run_id, status, title, reason, context_summary, requested_by_agent, expires_at)
            VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)
            """,
            (
                approval_id, run_id, step_id,
                str(data.get("label") or "Human Approval Required"),
                str(data.get("reason") or "Manual approval required before continuing."),
                f"Workflow run {run_id} paused at approval gate.",
                "workflow-runner",
                expires_at,
            ),
        )
    return approval_id


# ── host runner call ──────────────────────────────────────────────────────────

def _call_host_runner(path: str, body: dict) -> dict[str, Any]:
    base = str(get_settings().host_runner_url).rstrip("/")
    url = f"{base}{path}"
    payload = json.dumps(body).encode()
    req = urllib.request.Request(url, data=payload, method="POST")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            return json.loads(resp.read())
    except urllib.error.URLError as exc:
        return {
            "ok": False,
            "status": "host_runner_unavailable",
            "message": (
                "Specter Host Runner is unavailable. Start it from the Specter Agent repository with "
                "`python3 scripts/specter_host_runner.py`, then retry the workflow."
            ),
            "diagnostic": str(exc.reason),
            "stdout": "",
            "stderr": "",
            "final_message": "",
        }
    except Exception as exc:
        return {"ok": False, "message": str(exc), "stdout": "", "stderr": "", "final_message": ""}


# ── node executor ─────────────────────────────────────────────────────────────

def _build_prompt(node: dict, context: str) -> str:
    data = node.get("data") or {}
    node_type = node.get("type", "")
    label = str(data.get("label") or node["id"])
    role = str(data.get("role") or "")
    objective = str(data.get("objective") or "")
    instructions = str(data.get("systemInstructions") or "")

    parts = []
    if node_type == "supervisorAgent":
        goal = objective or "coordinate the workflow steps that follow"
        parts.append(
            f"You are {label}, a supervisor agent. Objective: {goal}. "
            "Do a QUICK scoping pass of this workspace: list the top 5 files or areas most "
            "relevant to the objective, then write a 3-bullet action plan for the downstream agents. "
            "Be concise — respond in under 300 words. Do NOT explore every file."
        )
        if instructions:
            parts.append(f"Additional context: {instructions}")
    elif node_type == "specialistAgent":
        focus = role or label
        parts.append(
            f"You are {label}, a specialist agent focused on: {focus}. "
            "Do a targeted check — look at 2-3 relevant files maximum. "
            "Report your findings in under 200 words with bullet points. "
            "Do NOT do an exhaustive scan."
        )
        if objective:
            parts.append(f"Objective: {objective}")
        if instructions:
            parts.append(f"Instructions: {instructions}")
    elif node_type == "memory":
        scope = str(data.get("scope") or "workflow")
        mem_label = str(data.get("label") or "memory entry")
        parts.append(
            f"You are a memory-writing agent. Your job is to synthesise the findings so far "
            f"into a concise structured summary for '{mem_label}' ({scope} scope). "
            f"Write 3-5 clear bullet points covering the key findings, decisions made, and any "
            f"areas flagged for follow-up. Be specific — use file names, package names, or node labels "
            f"where available. Do NOT explore files or run commands. Only summarise what is in the context below."
        )

    if context:
        parts.append(f"\nPrevious step context (use as background only):\n{context[-1500:]}")

    parts.append("\nRespond with a short structured summary only. Be concise.")
    return " ".join(parts)


def _is_cancelled(run_id: str) -> bool:
    with db_session() as db:
        row = db.execute("SELECT status FROM workflow_runs WHERE id = ?", (run_id,)).fetchone()
    return row is not None and row["status"] == "cancelled"


def _kill_job(job_token: str) -> None:
    try:
        base = str(get_settings().host_runner_url).rstrip("/")
        url = f"{base}/runtimes/codex/kill/{job_token}"
        req = urllib.request.Request(url, data=b"{}", method="POST")
        req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=5) as _:
            pass
    except Exception:
        pass  # best-effort


def _poll_progress(job_token: str, run_id: str, node_id: str, label: str, stop_event: threading.Event) -> None:
    """Poll host runner for live Codex progress lines and write them to run_logs. Kill on cancel."""
    base = str(get_settings().host_runner_url).rstrip("/")
    seen = 0
    interval = 12  # seconds between polls
    while not stop_event.is_set():
        stop_event.wait(interval)
        if stop_event.is_set():
            break
        # kill Codex immediately if run was cancelled
        if _is_cancelled(run_id):
            _kill_job(job_token)
            break
        try:
            url = f"{base}/runtimes/codex/tail/{job_token}?since={seen}"
            req = urllib.request.Request(url, method="GET")
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read())
            new_lines = data.get("lines") or []
            if new_lines:
                snippet = " · ".join(str(l)[:120] for l in new_lines[:5])
                _write_log(run_id, "info", f"[{label}] {snippet}", {"node_id": node_id, "progress": True})
                seen += len(new_lines)
            if data.get("done"):
                break
        except Exception:
            pass


def _execute_node(node: dict, workspace_path: str, context: str, run_id: str) -> tuple[str, str, str]:
    """Returns (status, stdout, summary)."""
    data = node.get("data") or {}
    node_type = node.get("type", "")
    label = str(data.get("label") or node["id"])

    if node_type == "humanApproval":
        return "waiting_approval", "", str(data.get("reason") or "Awaiting human approval.")

    # agent nodes → dispatch to host runner (codex, claude, or cursor)
    job_token = str(uuid4())
    prompt = _build_prompt(node, context)
    agent = str(data.get("sandboxAgent") or data.get("agent") or "codex").strip().lower()
    runtime = str(data.get("runtime") or "sandbox").strip().lower()

    stop_event = threading.Event()
    poll_thread = threading.Thread(
        target=_poll_progress,
        args=(job_token, run_id, node["id"], label, stop_event),
        daemon=True,
    )
    poll_thread.start()

    if runtime == "direct":
        # Direct CLI — fast, no sandbox overhead, runs on host with the selected agent
        host_path = "/runtimes/direct-cli/run"
        host_payload = {
            "agent": agent,
            "workspace_path": workspace_path,
            "prompt": prompt,
            "mode": "read-only",
            "timeout_seconds": 480,
            "job_token": job_token,
        }
        agent_label = f"{agent.title()} (Direct)"
    elif agent == "claude":
        host_path = "/runtimes/docker-sandbox/run"
        host_payload = {
            "agent": "claude",
            "workspace_path": workspace_path,
            "prompt": prompt,
            "mode": "read-only",
            "timeout_seconds": 480,
            "job_token": job_token,
        }
        agent_label = "Claude Code"
    elif agent == "cursor":
        host_path = "/runtimes/docker-sandbox/run"
        host_payload = {
            "agent": "cursor",
            "workspace_path": workspace_path,
            "prompt": prompt,
            "mode": "read-only",
            "timeout_seconds": 480,
            "job_token": job_token,
        }
        agent_label = "Cursor"
    else:
        host_path = "/runtimes/docker-sandbox/run"
        host_payload = {
            "agent": "codex",
            "workspace_path": workspace_path,
            "prompt": prompt,
            "mode": "read-only",
            "timeout_seconds": 480,
            "job_token": job_token,
        }
        agent_label = "Codex"

    result = _call_host_runner(host_path, host_payload)

    stop_event.set()
    poll_thread.join(timeout=5)

    # if cancelled while agent was running, return cancelled status
    if _is_cancelled(run_id):
        return "cancelled", "", "Run cancelled."

    stdout = str(result.get("stdout") or "")
    final_message = str(result.get("final_message") or "").strip()
    ok = bool(result.get("ok"))

    if not final_message:
        clean_lines = [l for l in stdout.splitlines() if l.strip() and not l.strip().startswith("{")]
        final_message = "\n".join(clean_lines[-60:]).strip() or stdout[-2000:]

    if result.get("status") == "timeout":
        _write_log(run_id, "warn", f"[{label}] {agent_label} timed out after 480s", {"node_id": node["id"]})

    if ok:
        return "completed", final_message, final_message
    else:
        err = str(result.get("message") or result.get("stderr") or f"{agent_label} run failed.")
        return "failed", final_message or err, err


# ── main runner (runs in background thread) ───────────────────────────────────

def _get_workflow_name(workflow_id: str) -> str:
    with db_session() as db:
        row = db.execute("SELECT name FROM workflows WHERE id = ?", (workflow_id,)).fetchone()
    return row["name"] if row else workflow_id


DEFAULT_MAX_PARALLEL_NODES = 3


def _max_parallel_nodes(nodes: list[dict]) -> int:
    """Read the supervisor's delegation strategy to decide level concurrency."""
    for node in nodes:
        if node.get("type") == "supervisorAgent":
            strategy = str((node.get("data") or {}).get("delegationStrategy") or "").strip()
            if strategy in ("parallel_delegation", "parallel_delegation_later"):
                return DEFAULT_MAX_PARALLEL_NODES
            return 1
    return 1


def _run_approval_node(run_id: str, node: dict, workflow_name: str, workspace_path: str) -> bool:
    """Handle a humanApproval node. Returns True to continue the run, False to stop."""
    data = node.get("data") or {}
    label = str(data.get("label") or node["id"])
    existing_step = _latest_step_for_node(run_id, node["id"])

    if existing_step and existing_step["status"] == "waiting_approval":
        step_id = existing_step["id"]
        approval = _approval_for_step(step_id)
        approval_id = approval["id"] if approval else _write_approval_request(run_id, step_id, node)
        if approval and approval["status"] == "approved":
            _update_step(step_id, "completed", summary="Approved by human reviewer.")
            _update_run_status(run_id, "running")
            _write_log(run_id, "info", f"Approval already granted, continuing: {label}", {"approval_id": approval_id})
            return True
    else:
        step_id = _write_step(run_id, node, "running")
        _update_step(step_id, "waiting_approval", summary=str(data.get("reason") or "Awaiting approval."))
        _update_run_status(run_id, "waiting_approval")
        approval_id = _write_approval_request(run_id, step_id, node)
        _write_log(run_id, "info", f"Paused at approval gate: {label}", {"approval_id": approval_id})

    approval_result = _wait_for_approval(approval_id)
    if approval_result != "approved":
        if approval_result == "expired":
            _update_step(step_id, "cancelled", error="Approval expired without response.")
            _update_run_status(run_id, "cancelled")
            _write_log(run_id, "warn", "Run cancelled: approval expired without response.")
            linear_logger.log_run_failure(run_id, workflow_name, label, "Approval expired without response.", workspace_path)
        else:
            _update_step(step_id, "failed", error="Approval rejected or revision requested.")
            _update_run_status(run_id, "failed")
            _write_log(run_id, "warn", "Run stopped: approval rejected or revision requested.")
            linear_logger.log_run_failure(run_id, workflow_name, label, "Approval rejected or revision requested.", workspace_path)
        return False

    _update_step(step_id, "completed", summary="Approved by human reviewer.")
    _update_run_status(run_id, "running")
    _write_log(run_id, "info", f"Approval granted, continuing: {label}")
    return True


def _run_single_node(run_id: str, node: dict, workspace_path: str, context: str) -> tuple[str, str]:
    """Execute one agent/memory node. Returns (status, summary)."""
    node_id = node["id"]
    label = str((node.get("data") or {}).get("label") or node_id)
    _write_log(run_id, "info", f"Starting node: {label}", {"node_id": node_id, "node_type": node.get("type", "unknown")})
    step_id = _write_step(run_id, node, "running")
    try:
        status, stdout, summary = _execute_node(node, workspace_path, context, run_id)
    except Exception as exc:
        status, stdout, summary = "failed", "", f"Node execution raised: {exc}"

    if status == "cancelled":
        _update_step(step_id, "cancelled", summary="Cancelled mid-execution.")
        _write_log(run_id, "info", f"Run cancelled during node: {label}")
        return status, summary

    _update_step(step_id, status, stdout=stdout, summary=summary, error=summary if status == "failed" else None)
    _write_log(run_id, "info" if status == "completed" else "error", f"Node {label}: {status}", {"node_id": node_id})
    return status, summary


def _run_level(run_id: str, nodes: list[dict], workspace_path: str, context: str, max_parallel: int) -> list[tuple[dict, str, str]]:
    """Execute a level's nodes, up to max_parallel concurrently. Returns [(node, status, summary)] in input order."""
    if len(nodes) == 1 or max_parallel <= 1:
        return [(node, *_run_single_node(run_id, node, workspace_path, context)) for node in nodes]

    with ThreadPoolExecutor(max_workers=min(max_parallel, len(nodes))) as pool:
        futures = [pool.submit(_run_single_node, run_id, node, workspace_path, context) for node in nodes]
        return [(node, *future.result()) for node, future in zip(nodes, futures)]


def run_workflow(run_id: str, workflow_id: str, graph: dict, workspace_path: str) -> None:
    nodes: list[dict] = graph.get("nodes") or []
    edges: list[dict] = graph.get("edges") or []
    workflow_name = _get_workflow_name(workflow_id)

    if not nodes:
        _update_run_status(run_id, "failed")
        _write_log(run_id, "error", "No nodes in workflow graph.")
        linear_logger.log_run_failure(run_id, workflow_name, "—", "No nodes in workflow graph.", workspace_path)
        return

    levels = topological_levels(nodes, edges)
    max_parallel = _max_parallel_nodes(nodes)
    mode = "parallel" if max_parallel > 1 else "sequential"
    _write_log(run_id, "info", f"Starting {mode} run: {len(nodes)} nodes across {len(levels)} levels.", {"run_id": run_id})
    _update_run_status(run_id, "running")

    accumulated_context = ""

    for level in levels:
        if _is_cancelled(run_id):
            _write_log(run_id, "info", "Run cancelled — stopping before next node.")
            return

        # skip already-completed nodes (resume after approval / restart)
        pending: list[dict] = []
        for node in level:
            label = str((node.get("data") or {}).get("label") or node["id"])
            existing_step = _latest_step_for_node(run_id, node["id"])
            if existing_step and existing_step["status"] == "completed":
                if existing_step["summary"]:
                    accumulated_context += f"\n\n[{label}]\n{existing_step['summary']}"
            else:
                pending.append(node)
        if not pending:
            continue

        if pending[0].get("type") == "humanApproval":
            # approval gates are always singleton levels
            label = str((pending[0].get("data") or {}).get("label") or pending[0]["id"])
            _write_log(run_id, "info", f"Starting node: {label}", {"node_id": pending[0]["id"], "node_type": "humanApproval"})
            if not _run_approval_node(run_id, pending[0], workflow_name, workspace_path):
                return
            continue

        if len(pending) > 1 and max_parallel > 1:
            _write_log(run_id, "info", f"Running {len(pending)} nodes in parallel (max {max_parallel} concurrent).")

        results = _run_level(run_id, pending, workspace_path, accumulated_context, max_parallel)

        failed_label: str | None = None
        failed_summary = ""
        for node, status, summary in results:
            label = str((node.get("data") or {}).get("label") or node["id"])
            if status == "cancelled":
                return
            if status == "failed" and failed_label is None:
                failed_label, failed_summary = label, summary
            if status == "completed" and summary:
                accumulated_context += f"\n\n[{label}]\n{summary}"

        if failed_label is not None:
            _update_run_status(run_id, "failed")
            _write_log(run_id, "error", f"Run failed at node: {failed_label}")
            linear_logger.log_run_failure(run_id, workflow_name, failed_label, failed_summary or "Node execution failed.", workspace_path)
            return

    _update_run_status(run_id, "completed")
    _write_log(run_id, "info", "Workflow run completed successfully.")
    linear_logger.log_run_complete(run_id, workflow_name)


def _wait_for_approval(approval_id: str) -> str:
    while True:
        time.sleep(5)
        now = datetime.now(timezone.utc)
        with db_session() as db:
            row = db.execute(
                "SELECT status, expires_at FROM approval_requests WHERE id = ?", (approval_id,)
            ).fetchone()
            if not row:
                return "missing"
            if row["status"] == "approved":
                return "approved"
            if row["status"] in ("rejected", "revision_requested", "expired"):
                return row["status"]
            expires_at = row["expires_at"]
            if expires_at and _parse_datetime(expires_at) <= now:
                db.execute(
                    "UPDATE approval_requests SET status = 'expired', resolved_at = ? WHERE id = ? AND status = 'pending'",
                    (_now(), approval_id),
                )
                return "expired"


def _parse_datetime(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _run_workflow_tracked(run_id: str, workflow_id: str, graph: dict, workspace_path: str) -> None:
    try:
        run_workflow(run_id, workflow_id, graph, workspace_path)
    finally:
        with _ACTIVE_RUNS_LOCK:
            _ACTIVE_RUNS.pop(run_id, None)


def is_run_active(run_id: str) -> bool:
    with _ACTIVE_RUNS_LOCK:
        thread = _ACTIVE_RUNS.get(run_id)
        if thread and thread.is_alive():
            return True
        _ACTIVE_RUNS.pop(run_id, None)
        return False


def start_run_async(run_id: str, workflow_id: str, graph: dict, workspace_path: str) -> bool:
    with _ACTIVE_RUNS_LOCK:
        thread = _ACTIVE_RUNS.get(run_id)
        if thread and thread.is_alive():
            return False
        t = threading.Thread(
            target=_run_workflow_tracked,
            args=(run_id, workflow_id, graph, workspace_path),
            daemon=True,
        )
        _ACTIVE_RUNS[run_id] = t
        t.start()
        return True


def recover_approved_waiting_runs() -> int:
    with db_session() as db:
        rows = db.execute(
            """
            SELECT DISTINCT wr.id, wr.workflow_id, wr.graph_json, wr.workspace_path
            FROM workflow_runs wr
            JOIN approval_requests ar ON ar.workflow_run_id = wr.id
            WHERE wr.status = 'waiting_approval'
              AND ar.status = 'approved'
              AND wr.workspace_path IS NOT NULL
              AND wr.workspace_path != ''
            """
        ).fetchall()

    recovered = 0
    for row in rows:
        try:
            graph = json.loads(row["graph_json"] or "{}")
            if start_run_async(row["id"], row["workflow_id"], graph, row["workspace_path"]):
                _write_log(row["id"], "info", "Recovered approved approval gate after app restart.")
                recovered += 1
        except Exception as exc:
            _write_log(row["id"], "error", f"Unable to recover approved approval gate: {exc}")
    return recovered
