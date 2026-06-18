from fastapi import APIRouter

from app.core.config import get_settings
from app.db.session import db_session

router = APIRouter(prefix="/health", tags=["health"])


@router.get("")
def health_check() -> dict:
    settings = get_settings()
    sqlite_status = "unavailable"
    journal_mode = "unknown"

    try:
        with db_session() as db:
            db.execute("SELECT 1")
            journal_mode = db.execute("PRAGMA journal_mode").fetchone()[0]
            sqlite_status = "healthy"
    except Exception as exc:
        sqlite_status = f"error: {exc}"

    return {
        "api": "ok",
        "sqlite": sqlite_status,
        "journal_mode": journal_mode,
        "db_path": str(settings.database_path),
        "scheduler": "active" if settings.scheduler_enabled else "disabled",
        "runtime": "local",
    }
