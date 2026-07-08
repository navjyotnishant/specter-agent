import json
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core.config import get_settings
from app.db.session import db_session
from app.runtime.auth import require_admin, require_user

router = APIRouter(prefix="/runtime-adapters", tags=["runtime-adapters"])


class HostRunnerModeRequest(BaseModel):
    maintenance_enabled: bool


class DockerSandboxPolicyRequest(BaseModel):
    policy: str = Field(pattern="^(allow-all|balanced|deny-all)$")


class McpAddRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    transport_type: str = Field(default="stdio")
    url: str | None = None
    command: list[str] | None = None
    env_vars: dict[str, str] = {}


class RuntimeWorkspaceRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    path: str = Field(min_length=1, max_length=500)


class RepositoryDiscoveryRequest(BaseModel):
    root_path: str = Field(min_length=1, max_length=500)
    max_depth: int = Field(default=3, ge=1, le=5)
    max_results: int = Field(default=50, ge=1, le=200)


class CodexRunRequest(BaseModel):
    workspace_id: str = Field(min_length=1)
    prompt: str = Field(min_length=1, max_length=4000)
    mode: str = "read-only"
    timeout_seconds: int = Field(default=180, ge=15, le=600)
    agent: str = "codex"  # sandbox agent key: "codex" | "claude" | "cursor"
    runtime: str = "sandbox"  # "sandbox" = Docker Sandbox, "direct" = Codex CLI on host


def call_host_runner(
    path: str,
    method: str = "GET",
    body: dict[str, Any] | None = None,
    timeout: float | None = None,
    fallback_runtime_id: str = "codex-cli",
    fallback_display_name: str = "Codex CLI Runtime",
) -> dict[str, Any]:
    settings = get_settings()
    url = f"{str(settings.host_runner_url).rstrip('/')}{path}"
    payload = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(url, data=payload, method=method)
    if body is not None:
        request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=timeout or settings.host_runner_timeout_seconds) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8")
        raise HTTPException(status_code=exc.code, detail=detail or "Host runner request failed") from exc
    except Exception as exc:
        return {
            "runtime_id": fallback_runtime_id,
            "display_name": fallback_display_name,
            "status": "host_runner_unavailable",
            "available": False,
            "installed": False,
            "host_runner_url": str(settings.host_runner_url),
            "message": "Host runner is offline. Start the Specter Host Runner on this machine, then re-check the runtime.",
            "diagnostic": str(exc),
        }


def public_workspace(row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "path": row["path"],
        "is_active": row["is_active"] == 1,
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def public_run(row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "runtime_id": row["runtime_id"],
        "workspace_id": row["workspace_id"],
        "workspace_path": row["workspace_path"],
        "prompt": row["prompt"],
        "mode": row["mode"],
        "status": row["status"],
        "exit_code": row["exit_code"],
        "stdout": row["stdout"],
        "stderr": row["stderr"],
        "summary": row["summary"],
        "error": row["error"],
        "started_at": row["started_at"],
        "completed_at": row["completed_at"],
        "metadata": json.loads(row["metadata_json"] or "{}"),
    }


def normalize_workspace_path(path: str) -> str:
    normalized = path.strip()
    if not normalized.startswith("/"):
        raise HTTPException(status_code=400, detail="Workspace path must be an absolute host path.")
    if ".." in Path(normalized).parts:
        raise HTTPException(status_code=400, detail="Workspace path cannot contain parent-directory traversal.")
    return normalized.rstrip("/")


@router.get("/codex-cli/status")
def codex_cli_status(_: dict = Depends(require_user)) -> dict[str, Any]:
    return call_host_runner("/runtimes/codex/status")


@router.get("/direct-cli/status")
def direct_cli_status(_: dict = Depends(require_user)) -> dict[str, Any]:
    return call_host_runner(
        "/runtimes/direct-cli/status",
        fallback_runtime_id="direct-cli",
        fallback_display_name="Direct CLI Runtime",
        timeout=15.0,
    )


@router.get("/docker-sandbox/status")
def docker_sandbox_status(_: dict = Depends(require_user)) -> dict[str, Any]:
    return call_host_runner(
        "/runtimes/docker-sandbox/status",
        fallback_runtime_id="docker-sandbox",
        fallback_display_name="Docker Sandbox Runtime",
    )


@router.post("/docker-sandbox/daemon/start")
def start_docker_sandbox_daemon(_: dict = Depends(require_admin)) -> dict[str, Any]:
    return call_host_runner("/runtimes/docker-sandbox/daemon/start", method="POST", timeout=20)


@router.get("/docker-sandbox/policy")
def docker_sandbox_policy(_: dict = Depends(require_user)) -> dict[str, Any]:
    return call_host_runner(
        "/runtimes/docker-sandbox/policy",
        fallback_runtime_id="docker-sandbox",
        fallback_display_name="Docker Sandbox Runtime",
    )


@router.post("/docker-sandbox/policy")
def set_docker_sandbox_policy(request: DockerSandboxPolicyRequest, _: dict = Depends(require_admin)) -> dict[str, Any]:
    return call_host_runner(
        "/runtimes/docker-sandbox/policy",
        method="POST",
        body={"policy": request.policy},
        fallback_runtime_id="docker-sandbox",
        fallback_display_name="Docker Sandbox Runtime",
        timeout=30,
    )


@router.get("/workspaces")
def list_runtime_workspaces(_: dict = Depends(require_user)) -> list[dict[str, Any]]:
    with db_session() as db:
        rows = db.execute("SELECT * FROM runtime_workspaces ORDER BY created_at DESC").fetchall()
        return [public_workspace(row) for row in rows]


@router.post("/workspaces")
def create_runtime_workspace(request: RuntimeWorkspaceRequest, user: dict = Depends(require_admin)) -> dict[str, Any]:
    workspace_id = str(uuid4())
    normalized_path = normalize_workspace_path(request.path)
    with db_session() as db:
        db.execute(
            """
            INSERT INTO runtime_workspaces (id, name, path, created_by)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(path) DO UPDATE SET
              name = excluded.name,
              is_active = 1,
              updated_at = CURRENT_TIMESTAMP
            """,
            (workspace_id, request.name.strip(), normalized_path, user["id"]),
        )
        row = db.execute("SELECT * FROM runtime_workspaces WHERE path = ?", (normalized_path,)).fetchone()
        return public_workspace(row)


@router.delete("/workspaces/{workspace_id}")
def deactivate_runtime_workspace(workspace_id: str, _: dict = Depends(require_admin)) -> dict[str, Any]:
    with db_session() as db:
        changed = db.execute(
            "UPDATE runtime_workspaces SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (workspace_id,),
        ).rowcount
    return {"updated": changed > 0, "workspace_id": workspace_id}


@router.post("/repositories/discover")
def discover_repositories(request: RepositoryDiscoveryRequest, _: dict = Depends(require_admin)) -> dict[str, Any]:
    root_path = normalize_workspace_path(request.root_path)
    return call_host_runner(
        "/repositories/discover",
        method="POST",
        body={"root_path": root_path, "max_depth": request.max_depth, "max_results": request.max_results},
        timeout=30,
    )


@router.get("/codex-cli/runs")
def list_codex_runs(_: dict = Depends(require_user)) -> list[dict[str, Any]]:
    with db_session() as db:
        rows = db.execute("SELECT * FROM runtime_runs ORDER BY started_at DESC LIMIT 25").fetchall()
        return [public_run(row) for row in rows]


@router.post("/codex-cli/runs")
def create_codex_run(request: CodexRunRequest, user: dict = Depends(require_admin)) -> dict[str, Any]:
    if request.mode != "read-only":
        raise HTTPException(status_code=400, detail="Only read-only Codex runtime tasks are currently supported.")

    with db_session() as db:
        workspace = db.execute(
            "SELECT * FROM runtime_workspaces WHERE id = ? AND is_active = 1",
            (request.workspace_id,),
        ).fetchone()
        if not workspace:
            raise HTTPException(status_code=404, detail="Approved workspace not found.")

    _supported = {"codex", "claude", "cursor"}
    agent = request.agent if request.agent in _supported else "codex"
    use_direct = request.runtime == "direct"
    run_id = str(uuid4())
    runtime_id = "codex-cli" if use_direct else "docker-sandbox"

    if use_direct:
        host_path = "/runtimes/direct-cli/run"
        payload = {
            "workspace_path": workspace["path"],
            "prompt": request.prompt,
            "mode": request.mode,
            "timeout_seconds": request.timeout_seconds,
            "job_token": run_id,
            "agent": agent,
        }
    else:
        host_path = "/runtimes/docker-sandbox/run"
        payload = {
            "workspace_path": workspace["path"],
            "prompt": request.prompt,
            "mode": request.mode,
            "timeout_seconds": request.timeout_seconds,
            "job_token": run_id,
            "agent": agent,
        }

    with db_session() as db:
        db.execute(
            """
            INSERT INTO runtime_runs (id, runtime_id, workspace_id, workspace_path, prompt, mode, status, requested_by)
            VALUES (?, ?, ?, ?, ?, ?, 'running', ?)
            """,
            (run_id, runtime_id, workspace["id"], workspace["path"], request.prompt, request.mode, user["id"]),
        )

    result = call_host_runner(host_path, method="POST", body=payload, timeout=request.timeout_seconds + 60)
    _result_status = result.get("status", "")
    status = "completed" if result.get("ok") else (_result_status if _result_status in ("auth_required", "timeout") else "failed")
    stdout = str(result.get("stdout") or "")
    stderr = str(result.get("stderr") or "")
    summary = str(result.get("final_message") or stdout[-4000:])
    error = None if result.get("ok") else str(result.get("message") or result.get("error") or "Run failed.")

    with db_session() as db:
        db.execute(
            """
            UPDATE runtime_runs
            SET status = ?, exit_code = ?, stdout = ?, stderr = ?, summary = ?, error = ?,
                completed_at = CURRENT_TIMESTAMP, metadata_json = ?
            WHERE id = ?
            """,
            (
                status,
                result.get("exit_code"),
                stdout[-20000:],
                stderr[-12000:],
                summary,
                error,
                json.dumps({"host_runner": result.get("metadata", {})}),
                run_id,
            ),
        )
        row = db.execute("SELECT * FROM runtime_runs WHERE id = ?", (run_id,)).fetchone()
        return public_run(row)


@router.get("/host-runner/mode")
def host_runner_mode(_: dict = Depends(require_user)) -> dict[str, Any]:
    return call_host_runner("/mode")


@router.post("/host-runner/mode")
def set_host_runner_mode(request: HostRunnerModeRequest, _: dict = Depends(require_admin)) -> dict[str, Any]:
    return call_host_runner("/mode", method="POST", body={"maintenance_enabled": request.maintenance_enabled})


@router.get("/host-runner/logs")
def host_runner_logs(
    since: int = 0,
    level: str | None = None,
    limit: int = 200,
    _: dict = Depends(require_user),
) -> dict[str, Any]:
    qs = f"?since={since}&limit={min(limit, 500)}"
    if level:
        qs += f"&level={level}"
    return call_host_runner(f"/logs{qs}")


@router.get("/mcp/list")
def mcp_list(client: str = "codex", _: dict = Depends(require_user)) -> dict[str, Any]:
    return call_host_runner(f"/mcp/list?client={client}", timeout=15)


@router.post("/mcp/add")
def mcp_add(request: McpAddRequest, client: str = "codex", _: dict = Depends(require_admin)) -> dict[str, Any]:
    return call_host_runner(f"/mcp/add?client={client}", method="POST", body=request.model_dump(), timeout=30)


@router.post("/mcp/remove/{name}")
def mcp_remove(name: str, client: str = "codex", _: dict = Depends(require_admin)) -> dict[str, Any]:
    return call_host_runner(f"/mcp/remove/{name}?client={client}", method="POST", timeout=15)


@router.get("/mcp/login/{name}")
def mcp_login_instructions(name: str, client: str = "codex", _: dict = Depends(require_user)) -> dict[str, Any]:
    return call_host_runner(f"/mcp/login/{name}?client={client}", timeout=5)


@router.post("/codex-cli/install")
def install_codex_cli(_: dict = Depends(require_admin)) -> dict[str, Any]:
    return call_host_runner("/runtimes/codex/install", method="POST", timeout=360)


@router.post("/codex-cli/upgrade")
def upgrade_codex_cli(_: dict = Depends(require_admin)) -> dict[str, Any]:
    return call_host_runner("/runtimes/codex/upgrade", method="POST", timeout=360)


@router.get("/host-runner/version")
def host_runner_version(_: dict = Depends(require_user)) -> dict[str, Any]:
    return call_host_runner("/version", timeout=3)


@router.get("/host-runner/launchd/status")
def launchd_status(_: dict = Depends(require_user)) -> dict[str, Any]:
    return call_host_runner("/launchd/status", timeout=5)


@router.post("/host-runner/launchd/install")
def launchd_install(_: dict = Depends(require_admin)) -> dict[str, Any]:
    return call_host_runner("/launchd/install", method="POST", timeout=15)


@router.post("/host-runner/launchd/uninstall")
def launchd_uninstall(_: dict = Depends(require_admin)) -> dict[str, Any]:
    return call_host_runner("/launchd/uninstall", method="POST", timeout=15)


@router.post("/host-runner/launchd/restart")
def launchd_restart(_: dict = Depends(require_admin)) -> dict[str, Any]:
    return call_host_runner("/launchd/restart", method="POST", timeout=10)
