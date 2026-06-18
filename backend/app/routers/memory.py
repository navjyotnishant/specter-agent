from fastapi import APIRouter

from app.db.session import db_session
from app.runtime.memory import read_memory

router = APIRouter(prefix="/runs", tags=["memory"])


@router.get("/{run_id}/memory")
def get_run_memory(run_id: str) -> list[dict]:
    return read_memory(run_id)


@router.delete("/{run_id}/memory")
def clear_run_memory(run_id: str) -> dict:
    with db_session() as db:
        deleted = db.execute("DELETE FROM memory_entries WHERE workflow_run_id = ?", (run_id,)).rowcount
    return {"deleted": deleted, "run_id": run_id}
