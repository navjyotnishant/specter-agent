from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.db.session import db_session
from app.runtime.auth import require_user

router = APIRouter(prefix="/model-providers", tags=["model-providers"])


class ModelProviderRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    provider_type: str = Field(min_length=1, max_length=80)
    base_url: str | None = None
    is_configured: bool = False


@router.get("")
def list_model_providers(_: dict = Depends(require_user)) -> list[dict]:
    with db_session() as db:
        rows = db.execute("SELECT * FROM model_providers ORDER BY created_at DESC").fetchall()
        return [dict(row) for row in rows]


@router.post("")
def create_model_provider(request: ModelProviderRequest, _: dict = Depends(require_user)) -> dict:
    provider_id = str(uuid4())
    with db_session() as db:
        db.execute(
            """
            INSERT INTO model_providers (id, name, provider_type, base_url, is_configured)
            VALUES (?, ?, ?, ?, ?)
            """,
            (provider_id, request.name, request.provider_type, request.base_url, int(request.is_configured)),
        )
        row = db.execute("SELECT * FROM model_providers WHERE id = ?", (provider_id,)).fetchone()
        return dict(row)


@router.patch("/{provider_id}")
def update_model_provider(provider_id: str, request: ModelProviderRequest, _: dict = Depends(require_user)) -> dict:
    with db_session() as db:
        db.execute(
            """
            UPDATE model_providers
            SET name = ?, provider_type = ?, base_url = ?, is_configured = ?
            WHERE id = ?
            """,
            (request.name, request.provider_type, request.base_url, int(request.is_configured), provider_id),
        )
        row = db.execute("SELECT * FROM model_providers WHERE id = ?", (provider_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Model provider not found")
    return dict(row)


@router.delete("/{provider_id}")
def delete_model_provider(provider_id: str, _: dict = Depends(require_user)) -> dict:
    with db_session() as db:
        deleted = db.execute("DELETE FROM model_providers WHERE id = ?", (provider_id,)).rowcount
    return {"deleted": deleted > 0, "provider_id": provider_id}
