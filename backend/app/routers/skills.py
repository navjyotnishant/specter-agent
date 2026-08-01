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
    # Repo import supplies a slug id so an imported skill resolves by the same key the
    # source repo uses, and upserts so a re-import updates in place instead of duplicating.
    id: str | None = Field(default=None, pattern=r"^[a-z0-9][a-z0-9._-]{1,79}$")
    upsert: bool = False
    source_repo: str = ""


def _reject_duplicate_name(db, name: str, skill_id: str) -> None:
    """Names are how a skill is picked in the builder, so two skills called the
    same thing are indistinguishable there. Compared case-insensitively and
    excluding the row being written, so a rename to its own name is fine."""
    clash = db.execute(
        "SELECT id FROM skills WHERE LOWER(name) = LOWER(?) AND id != ?", (name.strip(), skill_id)
    ).fetchone()
    if clash:
        raise HTTPException(
            status_code=409,
            detail=f"A skill named '{name.strip()}' already exists (id '{clash['id']}').",
        )


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
    skill_id = request.id or str(uuid4())
    with db_session() as db:
        _reject_duplicate_name(db, request.name, skill_id)
        existing = db.execute("SELECT id FROM skills WHERE id = ?", (skill_id,)).fetchone()
        if existing and not request.upsert:
            raise HTTPException(status_code=409, detail=f"Skill '{skill_id}' already exists.")
        if existing:
            db.execute(
                """
                UPDATE skills
                SET name = ?, description = ?, prompt_template = ?, compatible_agent_roles = ?, source_repo = ?
                WHERE id = ?
                """,
                (
                    request.name, request.description, request.prompt_template,
                    str(request.compatible_agent_roles), request.source_repo, skill_id,
                ),
            )
        else:
            db.execute(
                """
                INSERT INTO skills (id, name, description, prompt_template, compatible_agent_roles, source_repo)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    skill_id, request.name, request.description, request.prompt_template,
                    str(request.compatible_agent_roles), request.source_repo,
                ),
            )
        row = db.execute("SELECT * FROM skills WHERE id = ?", (skill_id,)).fetchone()
        return dict(row)


@router.patch("/{skill_id}")
def update_skill(skill_id: str, request: SkillRequest, _: dict = Depends(require_user)) -> dict:
    with db_session() as db:
        _reject_duplicate_name(db, request.name, skill_id)
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
