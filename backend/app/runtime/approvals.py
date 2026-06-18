from uuid import uuid4

from app.db.session import db_session


def create_approval_request(
    workflow_run_id: str,
    title: str,
    reason: str,
    requested_by_agent: str | None = None,
    context_summary: str = "",
    proposed_action_json: str = "{}",
    agent_run_id: str | None = None,
) -> str:
    approval_id = str(uuid4())
    with db_session() as db:
        db.execute(
            """
            INSERT INTO approval_requests (
              id, workflow_run_id, agent_run_id, title, reason, proposed_action_json,
              context_summary, requested_by_agent
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                approval_id,
                workflow_run_id,
                agent_run_id,
                title,
                reason,
                proposed_action_json,
                context_summary,
                requested_by_agent,
            ),
        )
        db.execute("UPDATE workflow_runs SET status = 'waiting_for_approval' WHERE id = ?", (workflow_run_id,))
    return approval_id


def resolve_approval(approval_id: str, status: str, user_id: str | None, comment: str | None) -> dict | None:
    with db_session() as db:
        db.execute(
            """
            UPDATE approval_requests
            SET status = ?, resolved_by_user_id = ?, resolved_at = CURRENT_TIMESTAMP,
                resolution_comment = ?
            WHERE id = ? AND status = 'pending'
            """,
            (status, user_id, comment, approval_id),
        )
        row = db.execute("SELECT * FROM approval_requests WHERE id = ?", (approval_id,)).fetchone()
        if not row:
            return None
        if status == "approved":
            db.execute("UPDATE workflow_runs SET status = 'running' WHERE id = ?", (row["workflow_run_id"],))
        elif status in {"rejected", "revision_requested"}:
            db.execute("UPDATE workflow_runs SET status = ? WHERE id = ?", (status, row["workflow_run_id"]))
        return dict(row)
