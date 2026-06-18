from uuid import uuid4

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.db.session import db_session
from app.runtime.agent_engine import start_security_review_demo
from app.runtime.agent_events import demo_agent_event_stream

router = APIRouter(tags=["agents"])


class AgentDefinitionRequest(BaseModel):
    name: str
    role: str
    description: str = ""
    system_instructions: str = ""
    default_provider_id: str | None = None
    default_model: str | None = None
    allowed_skill_ids: list[str] = []
    allowed_connector_ids: list[str] = []
    memory_scope_default: str = "workflow"
    max_iterations: int = 3
    requires_approval_default: bool = False


class DemoRunRequest(BaseModel):
    workflow_id: str = "security-review-team"
    objective: str = "Perform a local security review and prepare an auditable report."


@router.get("/agents")
def list_agents() -> list[dict]:
    with db_session() as db:
        rows = db.execute(
            """
            SELECT id, name, role, description, system_instructions, default_provider_id,
                   default_model, allowed_skill_ids, allowed_connector_ids,
                   memory_scope_default, max_iterations, requires_approval_default,
                   created_at, updated_at
            FROM agent_definitions
            ORDER BY created_at DESC
            """
        ).fetchall() if _table_exists(db, "agent_definitions") else []
        return [dict(row) for row in rows]


@router.post("/agents")
def create_agent(request: AgentDefinitionRequest) -> dict:
    agent_id = str(uuid4())
    with db_session() as db:
        _ensure_agent_definitions_table(db)
        db.execute(
            """
            INSERT INTO agent_definitions (
              id, name, role, description, system_instructions, default_provider_id,
              default_model, allowed_skill_ids, allowed_connector_ids, memory_scope_default,
              max_iterations, requires_approval_default, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            """,
            (
                agent_id,
                request.name,
                request.role,
                request.description,
                request.system_instructions,
                request.default_provider_id,
                request.default_model,
                str(request.allowed_skill_ids),
                str(request.allowed_connector_ids),
                request.memory_scope_default,
                request.max_iterations,
                int(request.requires_approval_default),
            ),
        )
    return {"id": agent_id, **request.model_dump()}


@router.get("/agents/{agent_id}")
def get_agent(agent_id: str) -> dict:
    with db_session() as db:
        if not _table_exists(db, "agent_definitions"):
            raise HTTPException(status_code=404, detail="Agent not found")
        row = db.execute("SELECT * FROM agent_definitions WHERE id = ?", (agent_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Agent not found")
    return dict(row)


@router.patch("/agents/{agent_id}")
def update_agent(agent_id: str, request: AgentDefinitionRequest) -> dict:
    with db_session() as db:
        if not _table_exists(db, "agent_definitions"):
            raise HTTPException(status_code=404, detail="Agent not found")
        db.execute(
            """
            UPDATE agent_definitions
            SET name = ?, role = ?, description = ?, system_instructions = ?,
                default_provider_id = ?, default_model = ?, allowed_skill_ids = ?,
                allowed_connector_ids = ?, memory_scope_default = ?, max_iterations = ?,
                requires_approval_default = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (
                request.name,
                request.role,
                request.description,
                request.system_instructions,
                request.default_provider_id,
                request.default_model,
                str(request.allowed_skill_ids),
                str(request.allowed_connector_ids),
                request.memory_scope_default,
                request.max_iterations,
                int(request.requires_approval_default),
                agent_id,
            ),
        )
    return {"id": agent_id, **request.model_dump()}


@router.delete("/agents/{agent_id}")
def delete_agent(agent_id: str) -> dict:
    with db_session() as db:
        if _table_exists(db, "agent_definitions"):
            db.execute("DELETE FROM agent_definitions WHERE id = ?", (agent_id,))
    return {"deleted": agent_id}


@router.post("/runs/security-review-demo")
def start_demo_run(request: DemoRunRequest) -> dict:
    run_id = start_security_review_demo(request.workflow_id, request.objective)
    return {"run_id": run_id, "status": "waiting_for_approval"}


@router.get("/runs/{run_id}/events")
def run_events(run_id: str) -> StreamingResponse:
    return StreamingResponse(demo_agent_event_stream(run_id), media_type="text/event-stream")


def _table_exists(db, table_name: str) -> bool:
    row = db.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", (table_name,)).fetchone()
    return row is not None


def _ensure_agent_definitions_table(db) -> None:
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_definitions (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          role TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          system_instructions TEXT NOT NULL DEFAULT '',
          default_provider_id TEXT,
          default_model TEXT,
          allowed_skill_ids TEXT NOT NULL DEFAULT '[]',
          allowed_connector_ids TEXT NOT NULL DEFAULT '[]',
          memory_scope_default TEXT NOT NULL DEFAULT 'workflow',
          max_iterations INTEGER NOT NULL DEFAULT 3,
          requires_approval_default INTEGER NOT NULL DEFAULT 0,
          created_by TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
