from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.db.session import db_session
from app.runtime.auth import require_admin, require_user
from app.runtime.graph_runner import is_run_active, start_run_async

router = APIRouter(prefix="/workflow-runs", tags=["workflow-runs"])


class StartRunRequest(BaseModel):
    workflow_id: str = Field(min_length=1)
    # Blank falls back to the first approved workspace -- a Telegram message
    # carries no workspace, and the UI already picks one per run.
    workspace_path: str = ""
    graph: dict = {}
    # Values supplied at run time by the workflow's trigger nodes, keyed by the
    # trigger's field name (e.g. {"topic": "How we built repo import"}).
    run_input: dict[str, str] = {}
    trigger_type: str = "manual"


def _public_run(row) -> dict[str, Any]:
    graph_json = row["graph_json"] if "graph_json" in row.keys() else "{}"
    return {
        "id": row["id"],
        "workflow_id": row["workflow_id"],
        "status": row["status"],
        "trigger_type": row["trigger_type"],
        "workspace_path": row["workspace_path"] if "workspace_path" in row.keys() else None,
        "graph": json.loads(graph_json or "{}"),
        # Needed by the Telegram poller to report a result back to the chat.
        "final_report": row["final_report"] if "final_report" in row.keys() else None,
        "created_at": row["created_at"],
        "completed_at": row["completed_at"],
    }


def _public_step(row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "node_id": row["node_id"],
        "node_type": row["node_type"],
        "agent_name": row["agent_name"],
        "agent_role": row["agent_role"],
        "status": row["status"],
        "summary": row["summary"],
        "error": row["error"],
        "started_at": row["started_at"],
        "completed_at": row["completed_at"],
    }


def _public_log(row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "level": row["level"],
        "message": row["message"],
        "metadata": json.loads(row["metadata_json"] or "{}"),
        "created_at": row["created_at"],
    }


def _public_message(row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "agent_run_id": row["agent_run_id"],
        "sender_type": row["sender_type"],
        "sender_name": row["sender_name"],
        "content": row["content"],
        "created_at": row["created_at"],
    }


def _parse_datetime(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _expire_pending_approvals(run_id: str) -> None:
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()
    with db_session() as db:
        rows = db.execute(
            """
            SELECT id, workflow_step_run_id, expires_at
            FROM approval_requests
            WHERE workflow_run_id = ? AND status = 'pending' AND expires_at IS NOT NULL
            """,
            (run_id,),
        ).fetchall()
        expired = [row for row in rows if _parse_datetime(row["expires_at"]) <= now]
        if not expired:
            return
        for row in expired:
            db.execute(
                "UPDATE approval_requests SET status = 'expired', resolved_at = ? WHERE id = ? AND status = 'pending'",
                (now_iso, row["id"]),
            )
            if row["workflow_step_run_id"]:
                db.execute(
                    "UPDATE workflow_step_runs SET status = 'cancelled', completed_at = ? WHERE id = ?",
                    (now_iso, row["workflow_step_run_id"]),
                )
                db.execute(
                    "UPDATE agent_runs SET status = 'cancelled', completed_at = ?, error = ? WHERE id = ?",
                    (now_iso, "Approval expired without response.", row["workflow_step_run_id"]),
                )
        db.execute(
            "UPDATE workflow_runs SET status = 'cancelled', completed_at = ? WHERE id = ? AND status = 'waiting_approval'",
            (now_iso, run_id),
        )
        db.execute(
            "INSERT INTO run_logs (id, workflow_run_id, level, message, metadata_json) VALUES (?, ?, 'warn', ?, ?)",
            (str(uuid4()), run_id, "Run cancelled: approval expired without response.", json.dumps({"approval_status": "expired"})),
        )


def _ensure_pending_approval_open(run_id: str, approval_id: str):
    _expire_pending_approvals(run_id)
    with db_session() as db:
        row = db.execute("SELECT * FROM approval_requests WHERE id = ? AND workflow_run_id = ?", (approval_id, run_id)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Approval request not found.")
    if row["status"] != "pending":
        raise HTTPException(status_code=400, detail=f"Approval already resolved: {row['status']}")
    return row


def _get_approval(run_id: str, approval_id: str):
    _expire_pending_approvals(run_id)
    with db_session() as db:
        row = db.execute("SELECT * FROM approval_requests WHERE id = ? AND workflow_run_id = ?", (approval_id, run_id)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Approval request not found.")
    return row


def _normalize_workspace_path(path: str) -> str:
    return str(Path(path).expanduser().resolve())


def _approved_workspace_path(path: str) -> str:
    requested = Path(_normalize_workspace_path(path))
    with db_session() as db:
        rows = db.execute("SELECT path FROM runtime_workspaces WHERE is_active = 1").fetchall()
    candidates: list[tuple[int, str]] = []
    for row in rows:
        approved = Path(_normalize_workspace_path(row["path"]))
        if requested == approved or approved in requested.parents:
            candidates.append((len(approved.parts), str(approved)))
    if not candidates:
        raise HTTPException(status_code=403, detail="Workspace path is not approved for workflow execution.")
    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[0][1]


@router.post("")
def start_run(request: StartRunRequest, user: dict = Depends(require_admin)) -> dict[str, Any]:
    run_id = str(uuid4())
    workspace_path = request.workspace_path.strip()
    if not workspace_path:
        # Fall back to the workflow's OWN workspace, never a global default:
        # running workflow A against workflow B's repo would write to the wrong tree.
        with db_session() as db:
            row = db.execute(
                "SELECT workspace_path FROM workflows WHERE id = ?", (request.workflow_id,)
            ).fetchone()
        workspace_path = (row["workspace_path"] if row else "") or ""
        if not workspace_path:
            raise HTTPException(
                status_code=400,
                detail="This workflow has no workspace set. Open it in the builder, pick a repository, and save.",
            )
    workspace_path = _approved_workspace_path(workspace_path)

    # resolve graph — use saved workflow graph if not provided
    graph = request.graph
    if not graph.get("nodes"):
        with db_session() as db:
            wf = db.execute("SELECT graph_json FROM workflows WHERE id = ?", (request.workflow_id,)).fetchone()
        if not wf:
            raise HTTPException(status_code=404, detail="Workflow not found.")
        graph = json.loads(wf["graph_json"] or "{}")

    with db_session() as db:
        db.execute(
            "INSERT INTO workflow_runs (id, workflow_id, status, trigger_type, graph_json, workspace_path, run_input_json)"
            " VALUES (?, ?, 'queued', ?, ?, ?, ?)",
            (run_id, request.workflow_id, request.trigger_type, json.dumps(graph),
             workspace_path, json.dumps(request.run_input or {})),
        )

    # Remember it so a trigger-started run uses the same repo the UI last ran against.
    with db_session() as db:
        db.execute("UPDATE workflows SET workspace_path = ? WHERE id = ?",
                   (workspace_path, request.workflow_id))

    start_run_async(run_id, request.workflow_id, graph, workspace_path, request.run_input or {})

    return {"run_id": run_id, "status": "queued", "workflow_id": request.workflow_id, "workspace_path": workspace_path}


@router.get("")
def list_runs(
    workflow_id: str | None = None,
    limit: int = 100,
    _: dict = Depends(require_user),
) -> list[dict[str, Any]]:
    """Recent runs, newest first.

    The limit is a caller-visible parameter rather than a hidden 20: callers were
    treating the truncated page as a total, so a dashboard tile froze at 20 once
    the 21st run existed. Anything wanting real totals should use /stats.
    """
    limit = max(1, min(limit, 500))
    with db_session() as db:
        if workflow_id:
            rows = db.execute(
                "SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT ?",
                (workflow_id, limit),
            ).fetchall()
        else:
            rows = db.execute(
                "SELECT * FROM workflow_runs ORDER BY created_at DESC LIMIT ?", (limit,)
            ).fetchall()
    return [_public_run(r) for r in rows]


@router.get("/stats")
def run_stats(window_hours: int = 24, _: dict = Depends(require_user)) -> dict[str, Any]:
    """Aggregates computed in SQL over the whole table, not a page of it.

    Counting from a truncated list is how the attention banner could report
    "All clear" while failures sat just outside the loaded window.
    """
    window_hours = max(1, min(window_hours, 24 * 30))
    since = f"-{window_hours} hours"
    with db_session() as db:
        totals = db.execute(
            """
            SELECT
              COUNT(*)                                                   AS total,
              SUM(status = 'failed')                                     AS failed,
              SUM(status = 'completed')                                  AS completed,
              SUM(status IN ('running', 'queued', 'waiting_approval'))   AS active
            FROM workflow_runs
            WHERE created_at >= datetime('now', ?)
            """,
            (since,),
        ).fetchone()
        # Active runs are counted without a window: a run started two days ago and
        # still going is exactly what an operator needs to see.
        active_all = db.execute(
            "SELECT COUNT(*) c FROM workflow_runs"
            " WHERE status IN ('running','queued','waiting_approval')"
        ).fetchone()["c"]
        median = db.execute(
            """
            SELECT AVG(secs) AS median FROM (
              SELECT (julianday(completed_at) - julianday(created_at)) * 86400 AS secs
              FROM workflow_runs
              WHERE completed_at IS NOT NULL AND created_at >= datetime('now', ?)
              ORDER BY secs
              LIMIT 2 - (SELECT COUNT(*) FROM workflow_runs
                         WHERE completed_at IS NOT NULL AND created_at >= datetime('now', ?)) % 2
              OFFSET (SELECT (COUNT(*) - 1) / 2 FROM workflow_runs
                      WHERE completed_at IS NOT NULL AND created_at >= datetime('now', ?))
            )
            """,
            (since, since, since),
        ).fetchone()
        # Oldest thing still running. "3 running" says nothing about whether one
        # has been stuck for an hour, which is the question an operator has.
        oldest = db.execute(
            "SELECT MIN(created_at) AS started FROM workflow_runs"
            " WHERE status IN ('running','queued','waiting_approval')"
        ).fetchone()["started"]

        # The same median over the PREVIOUS window, so the tile can show a
        # direction rather than a bare number. A duration with no trend cannot
        # tell you whether things are getting worse.
        prev_since = f"-{window_hours * 2} hours"
        prev_median = db.execute(
            """
            SELECT AVG(secs) AS median FROM (
              SELECT (julianday(completed_at) - julianday(created_at)) * 86400 AS secs
              FROM workflow_runs
              WHERE completed_at IS NOT NULL
                AND created_at >= datetime('now', ?) AND created_at < datetime('now', ?)
              ORDER BY secs
              LIMIT 2 - (SELECT COUNT(*) FROM workflow_runs
                         WHERE completed_at IS NOT NULL
                           AND created_at >= datetime('now', ?) AND created_at < datetime('now', ?)) % 2
              OFFSET (SELECT (COUNT(*) - 1) / 2 FROM workflow_runs
                      WHERE completed_at IS NOT NULL
                        AND created_at >= datetime('now', ?) AND created_at < datetime('now', ?))
            )
            """,
            (prev_since, since, prev_since, since, prev_since, since),
        ).fetchone()

        waiting = db.execute(
            "SELECT COUNT(*) c FROM workflow_runs WHERE status = 'waiting_approval'"
        ).fetchone()["c"]

    current_median = round(median["median"] or 0, 1)
    previous_median = round(prev_median["median"] or 0, 1)
    return {
        "window_hours": window_hours,
        "total": totals["total"] or 0,
        "failed": totals["failed"] or 0,
        "completed": totals["completed"] or 0,
        "active": active_all,
        "waiting_approval": waiting,
        "oldest_active_started_at": oldest,
        "median_duration_seconds": current_median,
        "previous_median_duration_seconds": previous_median,
        # None rather than 0 when there is no prior window: "no change" and "no
        # data to compare" are different claims, and rendering the second as the
        # first invents a trend.
        "median_delta_seconds": (
            round(current_median - previous_median, 1) if previous_median else None
        ),
    }


@router.get("/{run_id}")
def get_run(run_id: str, _: dict = Depends(require_user)) -> dict[str, Any]:
    with db_session() as db:
        row = db.execute("SELECT * FROM workflow_runs WHERE id = ?", (run_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Run not found.")
    return _public_run(row)


@router.get("/{run_id}/steps")
def get_run_steps(run_id: str, _: dict = Depends(require_user)) -> list[dict[str, Any]]:
    with db_session() as db:
        rows = db.execute(
            """
            SELECT ar.*, ws.node_type
            FROM agent_runs ar
            LEFT JOIN workflow_step_runs ws ON ws.id = ar.id
            WHERE ar.workflow_run_id = ?
            ORDER BY ar.started_at ASC
            """,
            (run_id,),
        ).fetchall()
    return [_public_step(r) for r in rows]


@router.get("/{run_id}/logs")
def get_run_logs(run_id: str, _: dict = Depends(require_user)) -> list[dict[str, Any]]:
    with db_session() as db:
        rows = db.execute(
            "SELECT * FROM run_logs WHERE workflow_run_id = ? ORDER BY created_at ASC",
            (run_id,),
        ).fetchall()
    return [_public_log(r) for r in rows]


@router.get("/{run_id}/steps/{step_id}/messages")
def get_step_messages(run_id: str, step_id: str, _: dict = Depends(require_user)) -> list[dict[str, Any]]:
    with db_session() as db:
        rows = db.execute(
            "SELECT * FROM agent_messages WHERE agent_run_id = ? ORDER BY created_at ASC",
            (step_id,),
        ).fetchall()
    return [_public_message(r) for r in rows]


class ApprovalActionRequest(BaseModel):
    note: str = ""


def _resume_payload(run_id: str) -> tuple[str, dict[str, Any], str]:
    with db_session() as db:
        row = db.execute(
            "SELECT workflow_id, graph_json, workspace_path FROM workflow_runs WHERE id = ?",
            (run_id,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Run not found.")
        workspace_path = row["workspace_path"]
        if not workspace_path:
            workspace = db.execute(
                "SELECT path FROM runtime_workspaces WHERE is_active = 1 ORDER BY updated_at DESC, created_at DESC LIMIT 1"
            ).fetchone()
            if not workspace:
                raise HTTPException(status_code=409, detail="Run cannot resume because no workspace path is stored or approved.")
            workspace_path = workspace["path"]
        return row["workflow_id"], json.loads(row["graph_json"] or "{}"), workspace_path


@router.post("/{run_id}/approve/{approval_id}")
def approve_run(run_id: str, approval_id: str, body: ApprovalActionRequest = ApprovalActionRequest(), _: dict = Depends(require_admin)) -> dict[str, Any]:
    approval = _get_approval(run_id, approval_id)
    if approval["status"] not in ("pending", "approved"):
        raise HTTPException(status_code=400, detail=f"Approval already resolved: {approval['status']}")
    with db_session() as db:
        if approval["status"] == "pending":
            db.execute(
                "UPDATE approval_requests SET status = 'approved', resolved_at = CURRENT_TIMESTAMP, resolution_comment = ? WHERE id = ?",
                (body.note or None, approval_id),
            )
        if approval["workflow_step_run_id"]:
            db.execute(
                "UPDATE workflow_step_runs SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?",
                (approval["workflow_step_run_id"],),
            )
            db.execute(
                "UPDATE agent_runs SET status = 'completed', completed_at = CURRENT_TIMESTAMP, summary = ? WHERE id = ?",
                ("Approved by human reviewer.", approval["workflow_step_run_id"]),
            )
        db.execute(
            "UPDATE workflow_runs SET status = 'running', completed_at = NULL WHERE id = ? AND status = 'waiting_approval'",
            (run_id,),
        )
        db.execute(
            "INSERT INTO run_logs (id, workflow_run_id, level, message, metadata_json) VALUES (?, ?, 'info', ?, ?)",
            (str(uuid4()), run_id, "Approval granted by human reviewer.", json.dumps({"approval_id": approval_id, "approval_status": approval["status"]})),
        )
    resumed = False
    if not is_run_active(run_id):
        workflow_id, graph, workspace_path = _resume_payload(run_id)
        resumed = start_run_async(run_id, workflow_id, graph, workspace_path)
    return {"approved": True, "approval_id": approval_id, "resumed": resumed}


@router.post("/{run_id}/reject/{approval_id}")
def reject_run(run_id: str, approval_id: str, body: ApprovalActionRequest = ApprovalActionRequest(), _: dict = Depends(require_admin)) -> dict[str, Any]:
    approval = _ensure_pending_approval_open(run_id, approval_id)
    with db_session() as db:
        db.execute(
            "UPDATE approval_requests SET status = 'rejected', resolved_at = CURRENT_TIMESTAMP, resolution_comment = ? WHERE id = ?",
            (body.note or None, approval_id),
        )
        if approval["workflow_step_run_id"]:
            db.execute(
                "UPDATE workflow_step_runs SET status = 'failed', completed_at = CURRENT_TIMESTAMP WHERE id = ?",
                (approval["workflow_step_run_id"],),
            )
            db.execute(
                "UPDATE agent_runs SET status = 'failed', completed_at = CURRENT_TIMESTAMP, error = ? WHERE id = ?",
                ("Approval rejected.", approval["workflow_step_run_id"]),
            )
        db.execute(
            "UPDATE workflow_runs SET status = 'failed', completed_at = CURRENT_TIMESTAMP WHERE id = ?",
            (run_id,),
        )
        db.execute(
            "INSERT INTO run_logs (id, workflow_run_id, level, message, metadata_json) VALUES (?, ?, 'warn', ?, ?)",
            (str(uuid4()), run_id, "Run stopped: approval rejected.", json.dumps({"approval_id": approval_id})),
        )
    return {"rejected": True, "approval_id": approval_id}


@router.post("/{run_id}/request-revision/{approval_id}")
def request_revision(run_id: str, approval_id: str, body: ApprovalActionRequest = ApprovalActionRequest(), _: dict = Depends(require_admin)) -> dict[str, Any]:
    approval = _ensure_pending_approval_open(run_id, approval_id)
    with db_session() as db:
        db.execute(
            "UPDATE approval_requests SET status = 'revision_requested', resolved_at = CURRENT_TIMESTAMP, resolution_comment = ? WHERE id = ?",
            (body.note or None, approval_id),
        )
        if approval["workflow_step_run_id"]:
            db.execute(
                "UPDATE workflow_step_runs SET status = 'failed', completed_at = CURRENT_TIMESTAMP WHERE id = ?",
                (approval["workflow_step_run_id"],),
            )
            db.execute(
                "UPDATE agent_runs SET status = 'failed', completed_at = CURRENT_TIMESTAMP, error = ? WHERE id = ?",
                ("Approval returned for revision.", approval["workflow_step_run_id"]),
            )
        # mark the run as failed so the graph stops
        db.execute(
            "UPDATE workflow_runs SET status = 'failed', completed_at = CURRENT_TIMESTAMP WHERE id = ?",
            (run_id,),
        )
        db.execute(
            "INSERT INTO run_logs (id, workflow_run_id, level, message, metadata_json) VALUES (?, ?, 'warn', ?, ?)",
            (str(uuid4()), run_id, "Run stopped: approval returned for revision.", json.dumps({"approval_id": approval_id})),
        )
    return {"revision_requested": True, "approval_id": approval_id}


@router.post("/{run_id}/cancel")
def cancel_run(run_id: str, _: dict = Depends(require_admin)) -> dict[str, Any]:
    with db_session() as db:
        db.execute(
            "UPDATE workflow_runs SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('queued','running','waiting_approval')",
            (run_id,),
        )
    return {"cancelled": True, "run_id": run_id}


@router.get("/{run_id}/approvals")
def get_run_approvals(run_id: str, _: dict = Depends(require_user)) -> list[dict[str, Any]]:
    _expire_pending_approvals(run_id)
    with db_session() as db:
        rows = db.execute(
            "SELECT * FROM approval_requests WHERE workflow_run_id = ? ORDER BY created_at ASC",
            (run_id,),
        ).fetchall()
    return [
        {
            "id": r["id"],
            "status": r["status"],
            "title": r["title"],
            "reason": r["reason"],
            "context_summary": r["context_summary"],
            "workflow_step_run_id": r["workflow_step_run_id"],
            "created_at": r["created_at"],
            "expires_at": r["expires_at"],
            "resolved_at": r["resolved_at"],
        }
        for r in rows
    ]
