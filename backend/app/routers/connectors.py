import json
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.db.session import db_session
from app.runtime.auth import require_user

router = APIRouter(prefix="/connectors", tags=["connectors"])


class ConnectorRequest(BaseModel):
    name: str = Field(min_length=1, max_length=140)
    connector_type: str = Field(min_length=1, max_length=80)
    config: dict = {}
    is_configured: bool = False


@router.get("")
def list_connectors(_: dict = Depends(require_user)) -> list[dict]:
    with db_session() as db:
        rows = db.execute("SELECT * FROM connectors ORDER BY created_at DESC").fetchall()
        return [dict(row) for row in rows]


@router.post("")
def create_connector(request: ConnectorRequest, _: dict = Depends(require_user)) -> dict:
    connector_id = str(uuid4())
    with db_session() as db:
        db.execute(
            """
            INSERT INTO connectors (id, name, connector_type, config_json, is_configured)
            VALUES (?, ?, ?, ?, ?)
            """,
            (connector_id, request.name, request.connector_type, json.dumps(request.config), int(request.is_configured)),
        )
        row = db.execute("SELECT * FROM connectors WHERE id = ?", (connector_id,)).fetchone()
        return dict(row)


@router.patch("/{connector_id}")
def update_connector(connector_id: str, request: ConnectorRequest, _: dict = Depends(require_user)) -> dict:
    with db_session() as db:
        db.execute(
            """
            UPDATE connectors
            SET name = ?, connector_type = ?, config_json = ?, is_configured = ?
            WHERE id = ?
            """,
            (request.name, request.connector_type, json.dumps(request.config), int(request.is_configured), connector_id),
        )
        row = db.execute("SELECT * FROM connectors WHERE id = ?", (connector_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Connector not found")
    return dict(row)


@router.delete("/{connector_id}")
def delete_connector(connector_id: str, _: dict = Depends(require_user)) -> dict:
    with db_session() as db:
        deleted = db.execute("DELETE FROM connectors WHERE id = ?", (connector_id,)).rowcount
    return {"deleted": deleted > 0, "connector_id": connector_id}
