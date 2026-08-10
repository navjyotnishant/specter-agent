from fastapi import APIRouter, Depends

from app.db.session import db_session
from app.runtime.auth import require_admin, require_user
from app.runtime.memory import read_memory

router = APIRouter(prefix="/runs", tags=["memory"])

# Both routes were previously open. A run's memory holds whatever the agents
# wrote about the repository they were pointed at, and DELETE wipes it -- an
# unauthenticated caller could read it or destroy it.


@router.get("/{run_id}/memory")
def get_run_memory(run_id: str, _: dict = Depends(require_user)) -> list[dict]:
    return read_memory(run_id)


@router.delete("/{run_id}/memory")
def clear_run_memory(run_id: str, _: dict = Depends(require_admin)) -> dict:
    with db_session() as db:
        deleted = db.execute("DELETE FROM memory_entries WHERE workflow_run_id = ?", (run_id,)).rowcount
    return {"deleted": deleted, "run_id": run_id}
