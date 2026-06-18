from uuid import uuid4

from app.db.session import db_session


def write_memory(
    run_id: str,
    scope: str,
    key: str,
    value: str,
    agent_run_id: str | None = None,
    sensitivity: str = "internal",
    created_by_agent: str | None = None,
) -> str:
    memory_id = str(uuid4())
    with db_session() as db:
        db.execute(
            """
            INSERT INTO memory_entries (
              id, workflow_run_id, scope, agent_run_id, key, value_text,
              sensitivity_label, created_by_agent
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (memory_id, run_id, scope, agent_run_id, key, value, sensitivity, created_by_agent),
        )
    return memory_id


def read_memory(run_id: str, scope: str | None = None, agent_run_id: str | None = None) -> list[dict]:
    query = "SELECT * FROM memory_entries WHERE workflow_run_id = ?"
    params: list[str] = [run_id]
    if scope:
        query += " AND scope = ?"
        params.append(scope)
    if agent_run_id:
        query += " AND (agent_run_id = ? OR scope IN ('workflow', 'team'))"
        params.append(agent_run_id)
    query += " ORDER BY created_at ASC"

    with db_session() as db:
        rows = db.execute(query, params).fetchall()
        return [dict(row) for row in rows]
