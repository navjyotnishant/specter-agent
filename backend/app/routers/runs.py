from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.db.session import db_session
from app.runtime.auth import require_admin, require_user
from app.runtime.graph_runner import start_run_async

router = APIRouter(prefix="/workflow-runs", tags=["workflow-runs"])


class StartRunRequest(BaseModel):
    workflow_id: str = Field(min_length=1)
    workspace_path: str = Field(min_length=1)
    graph: dict = {}


def _public_run(row) -> dict[str, Any]:
    graph_json = row["graph_json"] if "graph_json" in row.keys() else "{}"
    return {
        "id": row["id"],
        "workflow_id": row["workflow_id"],
        "status": row["status"],
        "trigger_type": row["trigger_type"],
        "graph": json.loads(graph_json or "{}"),
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


@router.post("")
def start_run(request: StartRunRequest, user: dict = Depends(require_admin)) -> dict[str, Any]:
    run_id = str(uuid4())

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
            "INSERT INTO workflow_runs (id, workflow_id, status, trigger_type, graph_json) VALUES (?, ?, 'queued', 'manual', ?)",
            (run_id, request.workflow_id, json.dumps(graph)),
        )

    start_run_async(run_id, request.workflow_id, graph, request.workspace_path)

    return {"run_id": run_id, "status": "queued", "workflow_id": request.workflow_id}


@router.get("")
def list_runs(workflow_id: str | None = None, _: dict = Depends(require_user)) -> list[dict[str, Any]]:
    with db_session() as db:
        if workflow_id:
            rows = db.execute(
                "SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 20",
                (workflow_id,),
            ).fetchall()
        else:
            rows = db.execute("SELECT * FROM workflow_runs ORDER BY created_at DESC LIMIT 20").fetchall()
    return [_public_run(r) for r in rows]


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


@router.post("/{run_id}/approve/{approval_id}")
def approve_run(run_id: str, approval_id: str, body: ApprovalActionRequest = ApprovalActionRequest(), _: dict = Depends(require_admin)) -> dict[str, Any]:
    _ensure_pending_approval_open(run_id, approval_id)
    with db_session() as db:
        db.execute(
            "UPDATE approval_requests SET status = 'approved', resolved_at = CURRENT_TIMESTAMP, resolution_comment = ? WHERE id = ?",
            (body.note or None, approval_id),
        )
    return {"approved": True, "approval_id": approval_id}


@router.post("/{run_id}/reject/{approval_id}")
def reject_run(run_id: str, approval_id: str, body: ApprovalActionRequest = ApprovalActionRequest(), _: dict = Depends(require_admin)) -> dict[str, Any]:
    _ensure_pending_approval_open(run_id, approval_id)
    with db_session() as db:
        db.execute(
            "UPDATE approval_requests SET status = 'rejected', resolved_at = CURRENT_TIMESTAMP, resolution_comment = ? WHERE id = ?",
            (body.note or None, approval_id),
        )
    return {"rejected": True, "approval_id": approval_id}


@router.post("/{run_id}/request-revision/{approval_id}")
def request_revision(run_id: str, approval_id: str, body: ApprovalActionRequest = ApprovalActionRequest(), _: dict = Depends(require_admin)) -> dict[str, Any]:
    _ensure_pending_approval_open(run_id, approval_id)
    with db_session() as db:
        db.execute(
            "UPDATE approval_requests SET status = 'revision_requested', resolved_at = CURRENT_TIMESTAMP, resolution_comment = ? WHERE id = ?",
            (body.note or None, approval_id),
        )
        # mark the run as failed so the graph stops
        db.execute(
            "UPDATE workflow_runs SET status = 'failed', completed_at = CURRENT_TIMESTAMP WHERE id = ?",
            (run_id,),
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
