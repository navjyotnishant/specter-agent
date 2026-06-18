from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.db.session import db_session
from app.runtime.approvals import resolve_approval

router = APIRouter(prefix="/approvals", tags=["approvals"])


class ResolutionRequest(BaseModel):
    user_id: str | None = None
    comment: str | None = None


@router.get("")
def list_approvals(status: str | None = None) -> list[dict]:
    query = "SELECT * FROM approval_requests"
    params: list[str] = []
    if status:
        query += " WHERE status = ?"
        params.append(status)
    query += " ORDER BY created_at DESC"
    with db_session() as db:
        return [dict(row) for row in db.execute(query, params).fetchall()]


@router.get("/{approval_id}")
def get_approval(approval_id: str) -> dict:
    with db_session() as db:
        row = db.execute("SELECT * FROM approval_requests WHERE id = ?", (approval_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Approval request not found")
    return dict(row)


@router.post("/{approval_id}/approve")
def approve(approval_id: str, request: ResolutionRequest) -> dict:
    approval = resolve_approval(approval_id, "approved", request.user_id, request.comment)
    if not approval:
        raise HTTPException(status_code=404, detail="Approval request not found")
    return approval


@router.post("/{approval_id}/reject")
def reject(approval_id: str, request: ResolutionRequest) -> dict:
    approval = resolve_approval(approval_id, "rejected", request.user_id, request.comment)
    if not approval:
        raise HTTPException(status_code=404, detail="Approval request not found")
    return approval


@router.post("/{approval_id}/request-revision")
def request_revision(approval_id: str, request: ResolutionRequest) -> dict:
    approval = resolve_approval(approval_id, "revision_requested", request.user_id, request.comment)
    if not approval:
        raise HTTPException(status_code=404, detail="Approval request not found")
    return approval
