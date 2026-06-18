from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.db.session import db_session
from app.runtime.auth import require_user

router = APIRouter(prefix="/skills", tags=["skills"])


class SkillRequest(BaseModel):
    name: str = Field(min_length=1, max_length=140)
    description: str = ""
    prompt_template: str = ""
    compatible_agent_roles: list[str] = []


@router.get("")
def list_skills(_: dict = Depends(require_user)) -> list[dict]:
    with db_session() as db:
        rows = db.execute("SELECT * FROM skills ORDER BY created_at DESC").fetchall()
        return [dict(row) for row in rows]


@router.get("/{skill_id}")
def get_skill(skill_id: str, _: dict = Depends(require_user)) -> dict:
    with db_session() as db:
        row = db.execute("SELECT * FROM skills WHERE id = ?", (skill_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Skill not found")
    return dict(row)


@router.post("")
def create_skill(request: SkillRequest, _: dict = Depends(require_user)) -> dict:
    skill_id = str(uuid4())
    with db_session() as db:
        db.execute(
            """
            INSERT INTO skills (id, name, description, prompt_template, compatible_agent_roles)
            VALUES (?, ?, ?, ?, ?)
            """,
            (skill_id, request.name, request.description, request.prompt_template, str(request.compatible_agent_roles)),
        )
        row = db.execute("SELECT * FROM skills WHERE id = ?", (skill_id,)).fetchone()
        return dict(row)


@router.patch("/{skill_id}")
def update_skill(skill_id: str, request: SkillRequest, _: dict = Depends(require_user)) -> dict:
    with db_session() as db:
        db.execute(
            """
            UPDATE skills
            SET name = ?, description = ?, prompt_template = ?, compatible_agent_roles = ?
            WHERE id = ?
            """,
            (request.name, request.description, request.prompt_template, str(request.compatible_agent_roles), skill_id),
        )
        row = db.execute("SELECT * FROM skills WHERE id = ?", (skill_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Skill not found")
    return dict(row)


@router.delete("/{skill_id}")
def delete_skill(skill_id: str, _: dict = Depends(require_user)) -> dict:
    with db_session() as db:
        deleted = db.execute("DELETE FROM skills WHERE id = ?", (skill_id,)).rowcount
    return {"deleted": deleted > 0, "skill_id": skill_id}
