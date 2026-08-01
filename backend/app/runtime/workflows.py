import json
from uuid import uuid4

from app.db.session import db_session


class DuplicateWorkflowName(ValueError):
    """Raised when a workflow name is already taken (case-insensitive)."""


def _reject_duplicate_name(db, name: str, workflow_id: str) -> None:
    """Workflows are chosen by name -- in the list, and by name from the Telegram
    bot -- so two with the same name are ambiguous at the point of use. Excludes
    the row being written so saving a workflow under its own name still works."""
    clash = db.execute(
        "SELECT id FROM workflows WHERE LOWER(name) = LOWER(?) AND id != ?",
        (name.strip(), workflow_id),
    ).fetchone()
    if clash:
        raise DuplicateWorkflowName(f"A workflow named '{name.strip()}' already exists.")


def create_workflow(name: str, description: str, graph: dict, workspace_path: str | None = None) -> dict:
    workflow_id = str(uuid4())
    with db_session() as db:
        _reject_duplicate_name(db, name, workflow_id)
        db.execute(
            "INSERT INTO workflows (id, name, description, graph_json, workspace_path, is_template)"
            " VALUES (?, ?, ?, ?, ?, 0)",
            (workflow_id, name, description, json.dumps(graph), workspace_path or ""),
        )
        row = db.execute("SELECT * FROM workflows WHERE id = ?", (workflow_id,)).fetchone()
    return _serialize_workflow(row)


def list_workflows() -> list[dict]:
    with db_session() as db:
        rows = db.execute("SELECT * FROM workflows ORDER BY created_at DESC").fetchall()
    return [_serialize_workflow(row) for row in rows]


def get_workflow(workflow_id: str) -> dict | None:
    with db_session() as db:
        row = db.execute("SELECT * FROM workflows WHERE id = ?", (workflow_id,)).fetchone()
    return _serialize_workflow(row) if row else None


def update_workflow(workflow_id: str, name: str, description: str, graph: dict,
                    workspace_path: str | None = None) -> dict | None:
    with db_session() as db:
        _reject_duplicate_name(db, name, workflow_id)
        # None means "unchanged" -- callers that don't manage the workspace
        # (template publish, planner) must not blank it.
        db.execute(
            """
            UPDATE workflows
            SET name = ?, description = ?, graph_json = ?,
                workspace_path = COALESCE(?, workspace_path),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (name, description, json.dumps(graph), workspace_path or None, workflow_id),
        )
        row = db.execute("SELECT * FROM workflows WHERE id = ?", (workflow_id,)).fetchone()
    return _serialize_workflow(row) if row else None


def set_template_flag(workflow_id: str, is_template: bool) -> dict | None:
    with db_session() as db:
        db.execute(
            "UPDATE workflows SET is_template = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (1 if is_template else 0, workflow_id),
        )
        row = db.execute("SELECT * FROM workflows WHERE id = ?", (workflow_id,)).fetchone()
    return _serialize_workflow(row) if row else None


def delete_workflow(workflow_id: str) -> bool:
    """Delete a workflow and everything that hangs off its runs.

    SQLite foreign keys are not enforced here (`PRAGMA foreign_keys` is off) and
    none of the child tables declare ON DELETE CASCADE, so deleting only the
    `workflows` row used to strand run history, step runs, logs, agent messages,
    memory entries, and approval requests with no owner and no UI to reach them.
    Delete children first so a failure part-way through never leaves a workflow
    row pointing at rows we already removed.
    """
    with db_session() as db:
        # Templates are protected -- match the guard used on the delete itself.
        if not db.execute(
            "SELECT 1 FROM workflows WHERE id = ? AND is_template = 0", (workflow_id,)
        ).fetchone():
            return False

        run_ids = [r[0] for r in db.execute(
            "SELECT id FROM workflow_runs WHERE workflow_id = ?", (workflow_id,)
        ).fetchall()]

        if run_ids:
            placeholders = ",".join("?" * len(run_ids))
            agent_run_ids = [r[0] for r in db.execute(
                f"SELECT id FROM agent_runs WHERE workflow_run_id IN ({placeholders})", run_ids
            ).fetchall()]

            # Deepest first: agent_messages -> agent_runs -> run-scoped tables.
            if agent_run_ids:
                db.execute(
                    f"DELETE FROM agent_messages WHERE agent_run_id IN ({','.join('?' * len(agent_run_ids))})",
                    agent_run_ids,
                )
            for table in (
                "approval_requests",
                "memory_entries",
                "agent_runs",
                "run_logs",
                "workflow_step_runs",
            ):
                db.execute(f"DELETE FROM {table} WHERE workflow_run_id IN ({placeholders})", run_ids)
            db.execute(f"DELETE FROM workflow_runs WHERE id IN ({placeholders})", run_ids)

        deleted = db.execute(
            "DELETE FROM workflows WHERE id = ? AND is_template = 0", (workflow_id,)
        ).rowcount
    return deleted > 0


def _serialize_workflow(row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"],
        "graph": json.loads(row["graph_json"] or "{}"),
        "is_template": bool(row["is_template"]),
        "workspace_path": row["workspace_path"] if "workspace_path" in row.keys() else "",
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }
