import os
import shutil
from datetime import datetime, timezone
from pathlib import Path

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


def _read_meminfo() -> dict[str, int] | None:
    meminfo_path = Path("/proc/meminfo")
    if not meminfo_path.exists():
        return None

    values: dict[str, int] = {}
    for line in meminfo_path.read_text().splitlines():
        key, _, raw_value = line.partition(":")
        if not raw_value:
            continue
        parts = raw_value.strip().split()
        if not parts:
            continue
        try:
            values[key] = int(parts[0]) * 1024
        except ValueError:
            continue
    return values


def _memory_status() -> dict:
    meminfo = _read_meminfo()
    if not meminfo:
        return {
            "status": "unavailable",
            "total_bytes": None,
            "used_bytes": None,
            "available_bytes": None,
            "used_percent": None,
            "message": "Memory metrics are unavailable on this platform.",
        }

    total = meminfo.get("MemTotal")
    available = meminfo.get("MemAvailable")
    if not total or available is None:
        return {
            "status": "unavailable",
            "total_bytes": total,
            "used_bytes": None,
            "available_bytes": available,
            "used_percent": None,
            "message": "Memory metrics are incomplete.",
        }

    used = max(0, total - available)
    used_percent = round((used / total) * 100, 1)
    status = "healthy" if used_percent < 80 else "warning" if used_percent < 92 else "critical"
    return {
        "status": status,
        "total_bytes": total,
        "used_bytes": used,
        "available_bytes": available,
        "used_percent": used_percent,
        "message": f"{used_percent}% memory used",
    }


def _load_status() -> dict:
    try:
        load_1, load_5, load_15 = os.getloadavg()
        cpu_count = os.cpu_count() or 1
        pressure = round((load_1 / cpu_count) * 100, 1)
        status = "healthy" if pressure < 80 else "warning" if pressure < 120 else "critical"
        return {
            "status": status,
            "load_1": round(load_1, 2),
            "load_5": round(load_5, 2),
            "load_15": round(load_15, 2),
            "cpu_count": cpu_count,
            "pressure_percent": pressure,
            "message": f"{round(load_1, 2)} load across {cpu_count} CPU cores",
        }
    except OSError:
        return {
            "status": "unavailable",
            "load_1": None,
            "load_5": None,
            "load_15": None,
            "cpu_count": os.cpu_count(),
            "pressure_percent": None,
            "message": "Load average is unavailable on this platform.",
        }


def _disk_status(path: Path) -> dict:
    try:
        usage = shutil.disk_usage(path)
        used = usage.total - usage.free
        used_percent = round((used / usage.total) * 100, 1) if usage.total else None
        status = "healthy"
        if used_percent is not None:
            status = "healthy" if used_percent < 80 else "warning" if used_percent < 92 else "critical"
        return {
            "status": status,
            "path": str(path),
            "total_bytes": usage.total,
            "used_bytes": used,
            "free_bytes": usage.free,
            "used_percent": used_percent,
            "message": f"{used_percent}% disk used" if used_percent is not None else "Disk usage available",
        }
    except OSError as exc:
        return {
            "status": "unavailable",
            "path": str(path),
            "total_bytes": None,
            "used_bytes": None,
            "free_bytes": None,
            "used_percent": None,
            "message": f"Disk metrics unavailable: {exc}",
        }


@router.get("/system")
def system_health() -> dict:
    settings = get_settings()
    disk_path = settings.database_path.parent if settings.database_path.parent.exists() else Path("/")

    return {
        "sampled_at": datetime.now(timezone.utc).isoformat(),
        "load": _load_status(),
        "memory": _memory_status(),
        "disk": _disk_status(disk_path),
    }
