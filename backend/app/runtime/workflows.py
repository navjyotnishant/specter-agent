import json
from pathlib import Path
from uuid import uuid4

from app.db.session import db_session


def seed_security_review_workflow() -> None:
    template_path = Path(__file__).resolve().parent.parent / "templates" / "security_review_team.json"
    template = json.loads(template_path.read_text(encoding="utf-8"))

    graph = {
        "nodes": template["nodes"],
        "edges": [
            {
                "id": f"edge-{index}",
                "source": source,
                "target": target,
                "animated": True,
            }
            for index, (source, target) in enumerate(template["edges"], start=1)
        ],
    }

    with db_session() as db:
        row = db.execute("SELECT id FROM workflows WHERE id = ?", (template["id"],)).fetchone()
        if row:
            return
        db.execute(
            """
            INSERT INTO workflows (id, name, description, graph_json, is_template)
            VALUES (?, ?, ?, ?, 1)
            """,
            (
                template["id"],
                template["name"],
                template["description"],
                json.dumps(graph),
            ),
        )


def create_workflow(name: str, description: str, graph: dict) -> dict:
    workflow_id = str(uuid4())
    with db_session() as db:
        db.execute(
            "INSERT INTO workflows (id, name, description, graph_json, is_template) VALUES (?, ?, ?, ?, 0)",
            (workflow_id, name, description, json.dumps(graph)),
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


def update_workflow(workflow_id: str, name: str, description: str, graph: dict) -> dict | None:
    with db_session() as db:
        db.execute(
            """
            UPDATE workflows
            SET name = ?, description = ?, graph_json = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (name, description, json.dumps(graph), workflow_id),
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
    with db_session() as db:
        deleted = db.execute("DELETE FROM workflows WHERE id = ? AND is_template = 0", (workflow_id,)).rowcount
    return deleted > 0


def _serialize_workflow(row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"],
        "graph": json.loads(row["graph_json"] or "{}"),
        "is_template": bool(row["is_template"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }
