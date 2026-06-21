# Primary author: Navjyot Nishant
# Created on: 2026-06-19
# Last updated: 2026-06-19 16:13 America/Chicago
# Description: Local host runner for Specter Agent runtime adapter checks.
# AI usage: Built with assistance from AI tools for implementation acceleration, review, and refactoring.

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


HOST = os.environ.get("SPECTER_HOST_RUNNER_HOST", "127.0.0.1")
PORT = int(os.environ.get("SPECTER_HOST_RUNNER_PORT", "8765"))
MAINTENANCE_MODE = os.environ.get("SPECTER_HOST_RUNNER_ENABLE_INSTALL") == "1"
CODEX_INSTALL_URL = "https://chatgpt.com/codex/install.sh"
CODEX_NPM_LATEST_URL = "https://registry.npmjs.org/@openai%2Fcodex/latest"
DOCKER_SANDBOX_CODEX_DOCS_URL = "https://docs.docker.com/ai/sandboxes/agents/codex/"
DOCKER_SANDBOX_PRODUCT_URL = "https://www.docker.com/products/docker-sandboxes/"
DOCKER_SANDBOX_TEMPLATE = "docker/sandbox-templates:codex"
SANDBOX_POLICY_VALUES = {"allow-all", "balanced", "deny-all"}
LOG_LOCK = threading.Lock()
RUNNER_LOGS: list[dict[str, Any]] = []
MAX_LOGS = 200

# ── live job progress store ───────────────────────────────────────────────────
_JOB_LOCK = threading.Lock()
_JOBS: dict[str, dict[str, Any]] = {}  # token → {lines: [...], done: bool, proc: Popen|None}


def _job_create(token: str) -> None:
    with _JOB_LOCK:
        _JOBS[token] = {"lines": [], "done": False, "proc": None}


def _job_set_proc(token: str, proc: Any) -> None:
    with _JOB_LOCK:
        if token in _JOBS:
            _JOBS[token]["proc"] = proc


def _job_append(token: str, line: str) -> None:
    with _JOB_LOCK:
        if token in _JOBS:
            _JOBS[token]["lines"].append(line)


def _job_done(token: str) -> None:
    with _JOB_LOCK:
        if token in _JOBS:
            _JOBS[token]["done"] = True
            _JOBS[token]["proc"] = None


def _job_kill(token: str) -> bool:
    with _JOB_LOCK:
        job = _JOBS.get(token)
        if not job:
            return False
        proc = job.get("proc")
        if proc is not None:
            try:
                proc.kill()
            except Exception:
                pass
        job["done"] = True
        job["proc"] = None
    return True


def _job_tail(token: str, since: int) -> dict[str, Any]:
    with _JOB_LOCK:
        job = _JOBS.get(token)
        if not job:
            return {"ok": False, "lines": [], "done": True}
        lines = job["lines"][since:]
        return {"ok": True, "lines": lines, "done": job["done"], "total": len(job["lines"])}
SCAN_IGNORE_DIRS = {
    ".cache",
    ".codex",
    ".git",
    ".next",
    ".venv",
    "build",
    "dist",
    "node_modules",
    "target",
    "vendor",
}


def maintenance_mode() -> bool:
    return MAINTENANCE_MODE


def log_event(level: str, message: str, **metadata: Any) -> None:
    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "level": level,
        "message": message,
        "metadata": metadata,
    }
    with LOG_LOCK:
        RUNNER_LOGS.append(entry)
        del RUNNER_LOGS[:-MAX_LOGS]
    print(f"{entry['timestamp']} {level.upper()} {message}")


def get_logs() -> dict[str, Any]:
    with LOG_LOCK:
        logs = list(RUNNER_LOGS)
    return {"logs": logs, "count": len(logs)}


def set_maintenance_mode(enabled: bool) -> dict[str, Any]:
    global MAINTENANCE_MODE
    MAINTENANCE_MODE = enabled
    mode = "maintenance" if enabled else "safe"
    log_event("info", f"Host runner switched to {mode} mode")
    return {
        "mode": mode,
        "maintenance_enabled": enabled,
        "install_enabled": enabled,
        "upgrade_enabled": enabled,
        "message": f"Host runner is in {mode} mode.",
    }


def runner_mode() -> dict[str, Any]:
    enabled = maintenance_mode()
    mode = "maintenance" if enabled else "safe"
    return {
        "mode": mode,
        "maintenance_enabled": enabled,
        "install_enabled": enabled,
        "upgrade_enabled": enabled,
        "message": f"Host runner is in {mode} mode.",
    }


def parse_version(value: str | None) -> str | None:
    if not value:
        return None
    match = re.search(r"(\d+\.\d+\.\d+)", value)
    return match.group(1) if match else None


def version_tuple(version: str | None) -> tuple[int, int, int] | None:
    if not version:
        return None
    parts = version.split(".")
    if len(parts) != 3:
        return None
    try:
        return int(parts[0]), int(parts[1]), int(parts[2])
    except ValueError:
        return None


def latest_codex_version() -> dict[str, Any]:
    try:
        request = urllib.request.Request(CODEX_NPM_LATEST_URL, headers={"Accept": "application/json"})
        with urllib.request.urlopen(request, timeout=2) as response:
            payload = json.loads(response.read().decode("utf-8"))
        return {
            "latest_version": payload.get("version"),
            "version_check_status": "ok",
            "version_check_message": "Latest Codex CLI version resolved from package metadata.",
        }
    except Exception as exc:
        log_event("warn", "Latest Codex CLI version check unavailable", error=str(exc))
        return {
            "latest_version": None,
            "version_check_status": "unavailable",
            "version_check_message": f"Latest version check unavailable: {exc}",
        }


def codex_candidate_paths() -> list[str]:
    paths: list[str] = []
    path_executable = shutil.which("codex")
    if path_executable:
        paths.append(path_executable)

    home = Path.home()
    for candidate in [
        home / ".local/bin/codex",
        Path("/opt/homebrew/bin/codex"),
        Path("/usr/local/bin/codex"),
    ]:
        if candidate.exists():
            paths.append(str(candidate))

    deduped: list[str] = []
    for path in paths:
        if path not in deduped:
            deduped.append(path)
    return deduped


def codex_version_for(executable: str) -> dict[str, Any]:
    version = "unknown"
    try:
        result = subprocess.run(
            [executable, "--version"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        version = (result.stdout or result.stderr).strip() or version
    except Exception as exc:
        version = f"version check failed: {exc}"

    return {
        "path": executable,
        "version": version,
        "parsed_version": parse_version(version),
    }


def best_codex_candidate() -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    candidates = [codex_version_for(path) for path in codex_candidate_paths()]
    if not candidates:
        return None, []

    def sort_key(candidate: dict[str, Any]) -> tuple[int, int, int]:
        return version_tuple(candidate.get("parsed_version")) or (0, 0, 0)

    best = sorted(candidates, key=sort_key, reverse=True)[0]
    return best, candidates


def sbx_candidate_paths() -> list[str]:
    paths: list[str] = []
    path_executable = shutil.which("sbx")
    if path_executable:
        paths.append(path_executable)

    for candidate in [
        Path("/opt/homebrew/bin/sbx"),
        Path("/usr/local/bin/sbx"),
    ]:
        if candidate.exists():
            paths.append(str(candidate))

    deduped: list[str] = []
    for path in paths:
        if path not in deduped:
            deduped.append(path)
    return deduped


def sbx_version_for(executable: str) -> dict[str, Any]:
    version = "unknown"
    status = "ok"
    daemon_available = False
    try:
        results = []
        for command in ([executable, "version"], [executable, "--version"]):
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
            results.append(result)
            if result.returncode == 0:
                break

        result = results[-1]
        version = (result.stdout or result.stderr).strip() or version
        daemon_available = "Server Version:" in version and "Server Version:  Unavailable" not in version
        if result.returncode != 0:
            status = "unavailable"
        elif not daemon_available:
            status = "daemon_unavailable"
    except Exception as exc:
        status = "unavailable"
        version = f"version check failed: {exc}"

    return {
        "path": executable,
        "version": version,
        "parsed_version": parse_version(version),
        "status": status,
        "daemon_available": daemon_available,
    }


def best_sbx_candidate() -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    candidates = [sbx_version_for(path) for path in sbx_candidate_paths()]
    if not candidates:
        return None, []

    def sort_key(candidate: dict[str, Any]) -> tuple[int, int, int]:
        return version_tuple(candidate.get("parsed_version")) or (0, 0, 0)

    best = sorted(candidates, key=sort_key, reverse=True)[0]
    return best, candidates


def docker_sandbox_status() -> dict[str, Any]:
    best, candidates = best_sbx_candidate()
    install_guidance = {
        "macos": "brew install docker/tap/sbx",
        "windows": "winget install Docker.sbx",
        "docs_url": DOCKER_SANDBOX_CODEX_DOCS_URL,
        "product_url": DOCKER_SANDBOX_PRODUCT_URL,
    }
    runner_mode_value = "maintenance" if maintenance_mode() else "safe"

    if not best:
        return {
            "runtime_id": "docker-sandbox",
            "display_name": "Docker Sandbox Runtime",
            "status": "missing",
            "available": False,
            "installed": False,
            "executable_path": None,
            "version": None,
            "current_version": None,
            "detected_installs": [],
            "sandbox_runtime_available": False,
            "sbx_installed": False,
            "sbx_version": None,
            "sandbox_health_status": "missing",
            "codex_sandbox_ready": False,
            "auth_required": None,
            "install_guidance": install_guidance,
            "recommended_runtime": "codex-cli",
            "base_image": DOCKER_SANDBOX_TEMPLATE,
            "runner_mode": runner_mode_value,
            "message": "Docker Sandboxes CLI is not installed. Install sbx to use isolated local agent execution.",
        }

    version = best["version"]
    daemon_available = bool(best.get("daemon_available"))
    healthy = best.get("status") == "ok" and daemon_available
    health_status = "cli_available" if healthy else "daemon_unavailable"
    return {
        "runtime_id": "docker-sandbox",
        "display_name": "Docker Sandbox Runtime",
        "status": "ready" if healthy else "daemon_unavailable",
        "available": healthy,
        "installed": True,
        "executable_path": best["path"],
        "version": version,
        "current_version": parse_version(version),
        "detected_installs": candidates,
        "sandbox_runtime_available": healthy,
        "sbx_installed": True,
        "sbx_version": version,
        "sandbox_health_status": health_status,
        "codex_sandbox_ready": healthy,
        "auth_required": None,
        "install_guidance": install_guidance,
        "recommended_runtime": "docker-sandbox" if healthy else "codex-cli",
        "base_image": DOCKER_SANDBOX_TEMPLATE,
        "runner_mode": runner_mode_value,
        "message": (
            "Docker Sandboxes is ready for isolated local execution."
            if healthy
            else "Docker Sandboxes CLI is installed, but the sandbox daemon is not reachable. Run sbx daemon start."
        ),
    }


def docker_sandbox_policy_status() -> dict[str, Any]:
    if not best_sbx_candidate()[0]:
        return {
            "ok": False,
            "status": "missing",
            "current_policy": None,
            "available_policies": sorted(SANDBOX_POLICY_VALUES),
            "message": "Docker Sandboxes CLI is not installed.",
        }

    result = subprocess.run(["sbx", "policy", "ls"], capture_output=True, text=True, timeout=10, check=False)
    output = (result.stdout or result.stderr).strip()
    current_policy = "custom"
    if result.returncode != 0:
        return {
            "ok": False,
            "status": "unavailable",
            "current_policy": None,
            "available_policies": sorted(SANDBOX_POLICY_VALUES),
            "message": "Docker Sandboxes policy status is unavailable.",
            "diagnostic": output[-2000:],
        }

    if "default-ai-services" in output and "default-package-managers" in output:
        current_policy = "balanced"
    elif "allow-all" in output or "default-allow-all" in output:
        current_policy = "allow-all"
    elif not output or "No policy rules" in output or "deny-all" in output:
        current_policy = "deny-all"

    return {
        "ok": True,
        "status": "ready",
        "current_policy": current_policy,
        "available_policies": sorted(SANDBOX_POLICY_VALUES),
        "message": f"Docker Sandboxes network policy is {current_policy}.",
        "raw": output[-8000:],
    }


def set_docker_sandbox_policy(payload: dict[str, Any]) -> dict[str, Any]:
    policy = str(payload.get("policy") or "").strip()
    if policy not in SANDBOX_POLICY_VALUES:
        return {
            "ok": False,
            "status": "rejected",
            "message": "Policy must be one of: allow-all, balanced, deny-all.",
            "available_policies": sorted(SANDBOX_POLICY_VALUES),
        }

    current = docker_sandbox_policy_status()
    if current.get("ok") and current.get("current_policy") == policy:
        current.update({"ok": True, "policy": policy, "status": "unchanged", "message": f"Docker Sandboxes policy is already {policy}."})
        return current

    reset_warning = ""
    if current.get("ok") and current.get("current_policy") not in {None, policy}:
        try:
            reset = subprocess.run(["sbx", "policy", "reset", "--force"], capture_output=True, text=True, timeout=45, check=False)
        except subprocess.TimeoutExpired as exc:
            output = "\n".join(part.decode("utf-8", errors="replace") if isinstance(part, bytes) else str(part) for part in [exc.stdout, exc.stderr] if part).strip()
            reset_warning = "Policy reset timed out after clearing the current default; continuing with set-default."
            log_event("warn", "Docker Sandboxes policy reset timed out; continuing with set-default", policy=policy, stderr=output[-1000:])
        else:
            if reset.returncode != 0:
                output = (reset.stdout or reset.stderr).strip()
                log_event("error", "Docker Sandboxes policy reset failed", policy=policy, stderr=output[-1000:])
                return {
                    "ok": False,
                    "status": "failed",
                    "policy": policy,
                    "message": output or "Docker Sandboxes policy reset failed.",
                }

    result = subprocess.run(["sbx", "policy", "set-default", policy], capture_output=True, text=True, timeout=30, check=False)
    output = (result.stdout or result.stderr).strip()
    if result.returncode != 0:
        log_event("error", "Docker Sandboxes policy update failed", policy=policy, stderr=output[-1000:])
        return {
            "ok": False,
            "status": "failed",
            "policy": policy,
            "message": output or "Docker Sandboxes policy update failed.",
        }

    log_event("info", "Docker Sandboxes policy updated", policy=policy)
    status = docker_sandbox_policy_status()
    status.update({
        "ok": True,
        "policy": policy,
        "status": "updated",
        "message": reset_warning or output or f"Docker Sandboxes policy set to {policy}.",
    })
    return status


def codex_status() -> dict[str, Any]:
    best, candidates = best_codex_candidate()
    if not best:
        return {
            "runtime_id": "codex-cli",
            "display_name": "Codex CLI Runtime",
            "status": "missing",
            "available": False,
            "installed": False,
            "executable_path": None,
            "version": None,
            "current_version": None,
            "latest_version": None,
            "outdated": None,
            "version_check_status": "skipped",
            "version_check_message": "Codex CLI is not installed.",
            "install_supported": True,
            "install_enabled": maintenance_mode(),
            "upgrade_supported": False,
            "upgrade_enabled": False,
            "sign_in_required": False,
            "runner_mode": "maintenance" if maintenance_mode() else "safe",
            "message": "Codex CLI is not installed or is not available on the host PATH.",
        }

    executable = best["path"]
    version = best["version"]
    current_version = parse_version(version)
    latest = latest_codex_version()
    current_tuple = version_tuple(current_version)
    latest_tuple = version_tuple(latest["latest_version"])
    outdated = latest_tuple > current_tuple if current_tuple and latest_tuple else None

    return {
        "runtime_id": "codex-cli",
        "display_name": "Codex CLI Runtime",
        "status": "ready",
        "available": True,
        "installed": True,
        "executable_path": executable,
        "version": version,
        "current_version": current_version,
        "detected_installs": candidates,
        "latest_version": latest["latest_version"],
        "outdated": outdated,
        "version_check_status": latest["version_check_status"],
        "version_check_message": latest["version_check_message"],
        "install_supported": True,
        "install_enabled": maintenance_mode(),
        "upgrade_supported": True,
        "upgrade_enabled": maintenance_mode(),
        "sign_in_required": True,
        "runner_mode": "maintenance" if maintenance_mode() else "safe",
        "message": "Codex CLI is installed. Complete or verify sign-in from the host terminal before running agent tasks.",
    }


def run_codex_installer(action: str) -> dict[str, Any]:
    if not maintenance_mode():
        log_event("warn", f"Blocked Codex CLI {action}; host runner is in safe mode")
        return {
            "ok": False,
            "status": f"{action}_disabled",
            "message": "Installer execution is disabled. Restart the host runner with SPECTER_HOST_RUNNER_ENABLE_INSTALL=1 to enable approved installs and upgrades.",
            "manual_command": "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
        }

    log_event("info", f"Starting Codex CLI {action}")
    with tempfile.TemporaryDirectory(prefix="specter-codex-install-") as temp_dir:
        script_path = Path(temp_dir) / "install.sh"
        urllib.request.urlretrieve(CODEX_INSTALL_URL, script_path)
        result = subprocess.run(
            ["sh", str(script_path)],
            capture_output=True,
            text=True,
            timeout=300,
            check=False,
        )

    if result.returncode == 0:
        log_event("info", f"Codex CLI {action} completed", exit_code=result.returncode)
    else:
        log_event("error", f"Codex CLI {action} failed", exit_code=result.returncode, stderr=result.stderr[-1000:])

    return {
        "ok": result.returncode == 0,
        "status": {"install": "installed", "upgrade": "upgraded"}.get(action, "completed") if result.returncode == 0 else f"{action}_failed",
        "exit_code": result.returncode,
        "stdout": result.stdout[-4000:],
        "stderr": result.stderr[-4000:],
        "runtime": codex_status(),
    }


def run_codex_task(payload: dict[str, Any]) -> dict[str, Any]:
    import time as _time
    workspace_path = str(payload.get("workspace_path") or "").strip()
    prompt = str(payload.get("prompt") or "").strip()
    mode = str(payload.get("mode") or "read-only").strip()
    timeout_seconds = int(payload.get("timeout_seconds") or 180)
    job_token = str(payload.get("job_token") or "")

    if mode != "read-only":
        return {"ok": False, "status": "rejected", "message": "Only read-only Codex tasks are supported by this runner."}
    if not prompt:
        return {"ok": False, "status": "rejected", "message": "Prompt is required."}

    workspace = Path(workspace_path).expanduser().resolve()
    if not workspace.exists() or not workspace.is_dir():
        return {"ok": False, "status": "rejected", "message": "Workspace path does not exist or is not a directory."}

    best, _ = best_codex_candidate()
    if not best:
        return {"ok": False, "status": "missing", "message": "Codex CLI is not installed."}

    if job_token:
        _job_create(job_token)

    executable = best["path"]
    command = [
        executable,
        "exec",
        "--cd",
        str(workspace),
        "--sandbox",
        "read-only",
        "--json",
        "--color",
        "never",
        prompt,
    ]
    log_event("info", "Starting Codex read-only task", workspace=str(workspace), timeout_seconds=timeout_seconds)

    all_stdout_lines: list[str] = []
    stderr_buf: list[str] = []
    timed_out = False

    try:
        proc = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        if job_token:
            _job_set_proc(job_token, proc)

        def _read_stderr() -> None:
            for line in proc.stderr:  # type: ignore[union-attr]
                stderr_buf.append(line.rstrip())

        stderr_thread = threading.Thread(target=_read_stderr, daemon=True)
        stderr_thread.start()

        deadline = _time.monotonic() + timeout_seconds
        for line in proc.stdout:  # type: ignore[union-attr]
            line = line.rstrip()
            all_stdout_lines.append(line)
            if job_token:
                append_codex_progress(job_token, line)
            if _time.monotonic() > deadline:
                proc.kill()
                timed_out = True
                break

        proc.wait()
        stderr_thread.join(timeout=2)

    except Exception as exc:
        if job_token:
            _job_done(job_token)
        return {"ok": False, "status": "error", "message": str(exc), "stdout": "", "stderr": "", "final_message": ""}

    if job_token:
        _job_done(job_token)

    if timed_out:
        log_event("error", "Codex task timed out", workspace=str(workspace), timeout_seconds=timeout_seconds)
        stdout_text = "\n".join(all_stdout_lines)
        return {
            "ok": False,
            "status": "timeout",
            "message": "Codex task timed out.",
            "exit_code": None,
            "stdout": stdout_text[-20000:],
            "stderr": "\n".join(stderr_buf)[-12000:],
            "final_message": extract_codex_final_message(stdout_text),
            "metadata": {"workspace_path": str(workspace), "mode": mode, "timeout_seconds": timeout_seconds},
        }

    stdout_text = "\n".join(all_stdout_lines)
    ok = proc.returncode == 0
    final_message = extract_codex_final_message(stdout_text)
    error_message = extract_codex_error_message(stdout_text)
    log_event(
        "info" if ok else "error",
        "Codex task completed" if ok else "Codex task failed",
        workspace=str(workspace),
        exit_code=proc.returncode,
    )
    return {
        "ok": ok,
        "status": "completed" if ok else "failed",
        "message": "Codex task completed." if ok else "Codex task failed.",
        "exit_code": proc.returncode,
        "stdout": stdout_text[-20000:],
        "stderr": "\n".join(stderr_buf)[-12000:],
        "final_message": final_message or error_message,
        "metadata": {
            "workspace_path": str(workspace),
            "mode": mode,
            "timeout_seconds": timeout_seconds,
            "command": "codex exec --sandbox read-only --json",
        },
    }


def append_codex_progress(job_token: str, line: str) -> None:
    stripped = line.strip()
    if not stripped:
        return
    if not stripped.startswith("{"):
        _job_append(job_token, stripped)
        return

    try:
        ev = json.loads(stripped)
        ev_type = ev.get("type", "") if isinstance(ev, dict) else ""
        if ev_type == "item.completed":
            item = ev.get("item") or {}
            text = item.get("text") or item.get("content") or ""
            if text and isinstance(text, str):
                _job_append(job_token, text[:2000])
        elif ev_type == "turn.completed":
            usage = ev.get("usage") or {}
            out_tok = usage.get("output_tokens", "?")
            _job_append(job_token, f"[turn completed - {out_tok} output tokens]")
    except Exception:
        return


def safe_sandbox_name(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9.+-]+", "-", value).strip("-").lower()
    return f"specter-{cleaned[:48] or 'run'}"


def run_sandbox_codex_task(payload: dict[str, Any]) -> dict[str, Any]:
    import time as _time
    workspace_path = str(payload.get("workspace_path") or "").strip()
    prompt = str(payload.get("prompt") or "").strip()
    mode = str(payload.get("mode") or "read-only").strip()
    timeout_seconds = int(payload.get("timeout_seconds") or 180)
    job_token = str(payload.get("job_token") or "")

    if mode != "read-only":
        return {"ok": False, "status": "rejected", "message": "Only read-only sandbox tasks are supported by this runner."}
    if not prompt:
        return {"ok": False, "status": "rejected", "message": "Prompt is required."}

    workspace = Path(workspace_path).expanduser().resolve()
    if not workspace.exists() or not workspace.is_dir():
        return {"ok": False, "status": "rejected", "message": "Workspace path does not exist or is not a directory."}

    sandbox_status = docker_sandbox_status()
    if sandbox_status.get("status") != "ready":
        return {
            "ok": False,
            "status": "sandbox_unavailable",
            "message": sandbox_status.get("message") or "Docker Sandbox runtime is not ready.",
            "metadata": {"runtime": sandbox_status},
        }

    if job_token:
        _job_create(job_token)

    sandbox_name = safe_sandbox_name(job_token or f"{workspace.name}-{int(_time.time())}")
    create_command = ["sbx", "create", "--clone", "--name", sandbox_name, "codex", str(workspace)]
    exec_command = [
        "sbx",
        "exec",
        sandbox_name,
        "codex",
        "exec",
        "--sandbox",
        "read-only",
        "--json",
        "--color",
        "never",
        prompt,
    ]

    all_stdout_lines: list[str] = []
    stderr_buf: list[str] = []
    timed_out = False
    proc: subprocess.Popen[str] | None = None
    deadline = _time.monotonic() + timeout_seconds

    def run_streaming(command: list[str], label: str) -> int | None:
        nonlocal proc, timed_out
        if job_token:
            _job_append(job_token, label)
        proc = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        if job_token:
            _job_set_proc(job_token, proc)

        def _read_stderr() -> None:
            for line in proc.stderr:  # type: ignore[union-attr]
                stripped = line.rstrip()
                stderr_buf.append(stripped)
                if job_token and stripped:
                    _job_append(job_token, stripped[:2000])

        stderr_thread = threading.Thread(target=_read_stderr, daemon=True)
        stderr_thread.start()

        for line in proc.stdout:  # type: ignore[union-attr]
            stripped = line.rstrip()
            all_stdout_lines.append(stripped)
            if job_token:
                append_codex_progress(job_token, stripped)
            if _time.monotonic() > deadline:
                proc.kill()
                timed_out = True
                break

        proc.wait()
        stderr_thread.join(timeout=2)
        return proc.returncode

    log_event("info", "Starting Docker Sandbox read-only Codex task", workspace=str(workspace), sandbox=sandbox_name, timeout_seconds=timeout_seconds)

    try:
        create_exit = run_streaming(create_command, "[sandbox] creating isolated clone")
        if create_exit != 0:
            stdout_text = "\n".join(all_stdout_lines)
            return {
                "ok": False,
                "status": "failed",
                "message": "Docker Sandbox creation failed.",
                "exit_code": create_exit,
                "stdout": stdout_text[-20000:],
                "stderr": "\n".join(stderr_buf)[-12000:],
                "final_message": "",
                "metadata": {"workspace_path": str(workspace), "mode": mode, "sandbox_name": sandbox_name, "runtime_id": "docker-sandbox"},
            }

        exec_exit = run_streaming(exec_command, "[sandbox] running Codex in read-only mode")
    except Exception as exc:
        if job_token:
            _job_done(job_token)
        return {"ok": False, "status": "error", "message": str(exc), "stdout": "", "stderr": "", "final_message": ""}
    finally:
        cleanup = subprocess.run(["sbx", "rm", "--force", sandbox_name], capture_output=True, text=True, timeout=30, check=False)
        if cleanup and cleanup.returncode != 0:
            log_event("warn", "Docker Sandbox cleanup failed", sandbox=sandbox_name, stderr=cleanup.stderr[-1000:])
        if job_token:
            _job_done(job_token)

    stdout_text = "\n".join(all_stdout_lines)
    stderr_text = "\n".join(stderr_buf)
    if timed_out:
        log_event("error", "Docker Sandbox Codex task timed out", workspace=str(workspace), sandbox=sandbox_name, timeout_seconds=timeout_seconds)
        return {
            "ok": False,
            "status": "timeout",
            "message": "Docker Sandbox Codex task timed out.",
            "exit_code": None,
            "stdout": stdout_text[-20000:],
            "stderr": stderr_text[-12000:],
            "final_message": extract_codex_final_message(stdout_text),
            "metadata": {"workspace_path": str(workspace), "mode": mode, "timeout_seconds": timeout_seconds, "sandbox_name": sandbox_name, "runtime_id": "docker-sandbox"},
        }

    ok = exec_exit == 0
    final_message = extract_codex_final_message(stdout_text)
    error_message = extract_codex_error_message(stdout_text)
    log_event(
        "info" if ok else "error",
        "Docker Sandbox Codex task completed" if ok else "Docker Sandbox Codex task failed",
        workspace=str(workspace),
        sandbox=sandbox_name,
        exit_code=exec_exit,
    )
    return {
        "ok": ok,
        "status": "completed" if ok else "failed",
        "message": "Docker Sandbox Codex task completed." if ok else error_message or "Docker Sandbox Codex task failed.",
        "exit_code": exec_exit,
        "stdout": stdout_text[-20000:],
        "stderr": stderr_text[-12000:],
        "final_message": final_message or error_message,
        "metadata": {
            "workspace_path": str(workspace),
            "mode": mode,
            "timeout_seconds": timeout_seconds,
            "sandbox_name": sandbox_name,
            "runtime_id": "docker-sandbox",
            "command": "sbx create --clone codex && sbx exec codex exec --sandbox read-only --json",
        },
    }


def extract_codex_final_message(stdout: str) -> str:
    final_message = ""
    for line in stdout.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        item = event.get("item") if isinstance(event, dict) else None
        if isinstance(item, dict) and item.get("type") == "agent_message":
            text = item.get("text")
            if isinstance(text, str):
                final_message = text
    return final_message


def extract_codex_error_message(stdout: str) -> str:
    error_message = ""
    for line in stdout.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict):
            continue
        if event.get("type") == "error":
            message = event.get("message")
            if isinstance(message, str):
                error_message = message
        elif event.get("type") == "turn.failed":
            error = event.get("error")
            if isinstance(error, dict) and isinstance(error.get("message"), str):
                error_message = error["message"]
    return error_message


# ── MCP catalog ─────────────────────────────────────────────────────────────
MCP_CATALOG: list[dict[str, Any]] = [
    {
        "id": "filesystem",
        "name": "filesystem",
        "display_name": "Filesystem",
        "description": "Read and write files on the local filesystem within approved paths.",
        "auth_type": "none",
        "transport_type": "stdio",
        "add_command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/"],
        "docs_url": "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    },
    {
        "id": "github",
        "name": "github",
        "display_name": "GitHub",
        "description": "Search repos, read files, manage issues and PRs via the GitHub API.",
        "auth_type": "token",
        "token_env_var": "GITHUB_TOKEN",
        "token_label": "GitHub Personal Access Token",
        "transport_type": "stdio",
        "add_command": ["npx", "-y", "@modelcontextprotocol/server-github"],
        "docs_url": "https://github.com/modelcontextprotocol/servers/tree/main/src/github",
    },
    {
        "id": "postgres",
        "name": "postgres",
        "display_name": "PostgreSQL",
        "description": "Run read-only SQL queries against a PostgreSQL database.",
        "auth_type": "token",
        "token_env_var": "POSTGRES_CONNECTION_STRING",
        "token_label": "Postgres connection string (postgresql://user:pass@host/db)",
        "transport_type": "stdio",
        "add_command": ["npx", "-y", "@modelcontextprotocol/server-postgres"],
        "docs_url": "https://github.com/modelcontextprotocol/servers/tree/main/src/postgres",
    },
    {
        "id": "brave-search",
        "name": "brave-search",
        "display_name": "Brave Search",
        "description": "Web and local search powered by the Brave Search API.",
        "auth_type": "token",
        "token_env_var": "BRAVE_API_KEY",
        "token_label": "Brave Search API Key",
        "transport_type": "stdio",
        "add_command": ["npx", "-y", "@modelcontextprotocol/server-brave-search"],
        "docs_url": "https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search",
    },
    {
        "id": "slack",
        "name": "slack",
        "display_name": "Slack",
        "description": "Read channels, post messages, and search Slack workspaces.",
        "auth_type": "token",
        "token_env_var": "SLACK_BOT_TOKEN",
        "token_label": "Slack Bot Token (xoxb-...)",
        "transport_type": "stdio",
        "add_command": ["npx", "-y", "@modelcontextprotocol/server-slack"],
        "docs_url": "https://github.com/modelcontextprotocol/servers/tree/main/src/slack",
    },
    {
        "id": "figma",
        "name": "figma",
        "display_name": "Figma",
        "description": "Read Figma designs, components, and assets.",
        "auth_type": "oauth",
        "transport_type": "streamable_http",
        "url": "https://mcp.figma.com/mcp",
        "add_command_url": "https://mcp.figma.com/mcp",
        "docs_url": "https://www.figma.com/developers/mcp",
    },
    {
        "id": "linear",
        "name": "linear",
        "display_name": "Linear",
        "description": "Create and update Linear issues, projects, and cycles.",
        "auth_type": "oauth",
        "transport_type": "streamable_http",
        "url": "https://mcp.linear.app/mcp",
        "add_command_url": "https://mcp.linear.app/mcp",
        "docs_url": "https://linear.app/docs/mcp",
    },
    {
        "id": "notion",
        "name": "notion",
        "display_name": "Notion",
        "description": "Read and write Notion pages and databases.",
        "auth_type": "oauth",
        "transport_type": "streamable_http",
        "url": "https://mcp.notion.com/mcp",
        "add_command_url": "https://mcp.notion.com/mcp",
        "docs_url": "https://developers.notion.com/docs/mcp",
    },
]


def mcp_list() -> dict[str, Any]:
    best, _ = best_codex_candidate()
    if not best:
        return {"ok": False, "servers": [], "message": "Codex CLI not installed."}
    try:
        result = subprocess.run(
            [best["path"], "mcp", "list", "--json"],
            capture_output=True, text=True, timeout=10, check=False,
        )
        servers = json.loads(result.stdout) if result.returncode == 0 else []
    except Exception as exc:
        log_event("warn", "codex mcp list failed", error=str(exc))
        servers = []

    # build lookup by name
    configured = {s["name"]: s for s in servers}

    # merge catalog entries with live status
    merged: list[dict[str, Any]] = []
    for entry in MCP_CATALOG:
        live = configured.get(entry["name"])
        if live:
            merged.append({**entry, "configured": True, "live": live, "auth_status": live.get("auth_status", "unknown"), "enabled": live.get("enabled", True)})
        else:
            merged.append({**entry, "configured": False, "live": None, "auth_status": None, "enabled": False})

    # also include any configured servers NOT in catalog
    catalog_names = {e["name"] for e in MCP_CATALOG}
    for name, live in configured.items():
        if name not in catalog_names:
            merged.append({
                "id": name, "name": name, "display_name": name,
                "description": "Custom MCP server.",
                "auth_type": "unknown",
                "transport_type": live.get("transport", {}).get("type", "unknown"),
                "configured": True, "live": live,
                "auth_status": live.get("auth_status", "unknown"),
                "enabled": live.get("enabled", True),
            })

    return {"ok": True, "servers": merged}


def mcp_add(payload: dict[str, Any]) -> dict[str, Any]:
    best, _ = best_codex_candidate()
    if not best:
        return {"ok": False, "message": "Codex CLI not installed."}

    name = str(payload.get("name") or "").strip()
    transport_type = str(payload.get("transport_type") or "stdio")
    url = str(payload.get("url") or "").strip()
    command = payload.get("command") or []
    env_vars = payload.get("env_vars") or {}  # dict of KEY: VALUE

    if not name:
        return {"ok": False, "message": "Name is required."}

    cmd = [best["path"], "mcp", "add", name]

    if transport_type == "streamable_http":
        if not url:
            return {"ok": False, "message": "URL is required for HTTP transport."}
        cmd += ["--url", url]
    else:
        if not command:
            return {"ok": False, "message": "Command is required for stdio transport."}
        cmd += ["--"] + [str(c) for c in command]

    for key, value in env_vars.items():
        cmd += ["--env", f"{key}={value}"]

    log_event("info", f"Adding MCP server: {name}", command=cmd)
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30, check=False)
        ok = result.returncode == 0
        if ok:
            log_event("info", f"MCP server added: {name}")
        else:
            log_event("warn", f"MCP server add failed: {name}", stderr=result.stderr)
        return {
            "ok": ok,
            "name": name,
            "stdout": result.stdout.strip(),
            "stderr": result.stderr.strip(),
            "message": f"MCP server '{name}' added." if ok else f"Failed to add MCP server '{name}': {result.stderr.strip()}",
        }
    except Exception as exc:
        log_event("error", f"MCP add exception: {name}", error=str(exc))
        return {"ok": False, "name": name, "message": str(exc)}


def mcp_remove(name: str) -> dict[str, Any]:
    best, _ = best_codex_candidate()
    if not best:
        return {"ok": False, "message": "Codex CLI not installed."}
    try:
        result = subprocess.run(
            [best["path"], "mcp", "remove", name],
            capture_output=True, text=True, timeout=15, check=False,
        )
        ok = result.returncode == 0
        log_event("info" if ok else "warn", f"MCP remove '{name}'", exit_code=result.returncode)
        return {"ok": ok, "name": name, "message": f"Removed '{name}'." if ok else result.stderr.strip()}
    except Exception as exc:
        return {"ok": False, "name": name, "message": str(exc)}


def mcp_login_instructions(name: str) -> dict[str, Any]:
    """Returns instructions for OAuth login — codex mcp login opens a browser interactively."""
    best, _ = best_codex_candidate()
    if not best:
        return {"ok": False, "message": "Codex CLI not installed."}
    return {
        "ok": True,
        "name": name,
        "requires_terminal": True,
        "command": f"codex mcp login {name}",
        "message": f"Run `codex mcp login {name}` in your terminal to complete OAuth. A browser window will open.",
    }


def discover_repositories(payload: dict[str, Any]) -> dict[str, Any]:
    root_value = str(payload.get("root_path") or "").strip()
    max_depth = min(max(int(payload.get("max_depth") or 3), 1), 5)
    max_results = min(max(int(payload.get("max_results") or 50), 1), 200)
    if not root_value:
        return {"ok": False, "message": "Root path is required.", "repositories": []}

    root = Path(root_value).expanduser().resolve()
    if not root.exists() or not root.is_dir():
        return {"ok": False, "message": "Root path does not exist or is not a directory.", "repositories": []}
    if root == Path.home():
        return {"ok": False, "message": "Choose a specific projects directory instead of the entire home directory.", "repositories": []}

    repositories: list[dict[str, Any]] = []
    visited = 0

    def stack_for(path: Path) -> list[str]:
        markers = {
            "package.json": "Node/TypeScript",
            "pyproject.toml": "Python",
            "requirements.txt": "Python",
            "go.mod": "Go",
            "Cargo.toml": "Rust",
            "docker-compose.yml": "Docker",
            "Dockerfile": "Docker",
        }
        return [label for marker, label in markers.items() if (path / marker).exists()]

    def git_remote(path: Path) -> str | None:
        try:
            result = subprocess.run(
                ["git", "-C", str(path), "remote", "get-url", "origin"],
                capture_output=True,
                text=True,
                timeout=3,
                check=False,
            )
            remote = result.stdout.strip()
            return remote or None
        except Exception:
            return None

    def walk(path: Path, depth: int) -> None:
        nonlocal visited
        if len(repositories) >= max_results:
            return
        visited += 1
        if (path / ".git").exists():
            repositories.append(
                {
                    "name": path.name,
                    "path": str(path),
                    "remote_url": git_remote(path),
                    "detected_stack": sorted(set(stack_for(path))),
                }
            )
            return
        if depth >= max_depth:
            return
        try:
            children = sorted(path.iterdir(), key=lambda child: child.name.lower())
        except PermissionError:
            return
        for child in children:
            if len(repositories) >= max_results:
                return
            if child.name in SCAN_IGNORE_DIRS or child.name.startswith("."):
                continue
            if child.is_dir():
                walk(child, depth + 1)

    log_event("info", "Starting repository discovery", root_path=str(root), max_depth=max_depth, max_results=max_results)
    walk(root, 0)
    log_event("info", "Repository discovery completed", root_path=str(root), discovered=len(repositories), visited=visited)
    return {
        "ok": True,
        "root_path": str(root),
        "repositories": repositories,
        "count": len(repositories),
        "max_depth": max_depth,
        "max_results": max_results,
    }


class HostRunnerHandler(BaseHTTPRequestHandler):
    server_version = "SpecterHostRunner/0.1"

    def do_GET(self) -> None:
        if self.path == "/health":
            self.write_json({"status": "ok", "runner": "specter-host-runner"})
            return
        if self.path == "/mode":
            self.write_json(runner_mode())
            return
        if self.path == "/logs":
            self.write_json(get_logs())
            return
        if self.path == "/runtimes/codex/status":
            self.write_json(codex_status())
            return
        if self.path == "/runtimes/docker-sandbox/status":
            self.write_json(docker_sandbox_status())
            return
        if self.path == "/runtimes/docker-sandbox/policy":
            self.write_json(docker_sandbox_policy_status())
            return
        if self.path == "/mcp/list":
            self.write_json(mcp_list())
            return
        if self.path.startswith("/mcp/login/"):
            name = self.path[len("/mcp/login/"):]
            self.write_json(mcp_login_instructions(name))
            return
        if self.path.startswith("/runtimes/codex/tail/"):
            token = self.path[len("/runtimes/codex/tail/"):]
            # optional ?since=N query param
            since = 0
            if "?" in token:
                token, qs = token.split("?", 1)
                for part in qs.split("&"):
                    if part.startswith("since="):
                        try:
                            since = int(part[6:])
                        except ValueError:
                            pass
            self.write_json(_job_tail(token, since))
            return
        self.write_json({"error": "Not found"}, status=HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        if self.path == "/mode":
            payload = self.read_json()
            enabled = bool(payload.get("maintenance_enabled"))
            self.write_json(set_maintenance_mode(enabled))
            return
        if self.path == "/runtimes/codex/install":
            status = HTTPStatus.OK if maintenance_mode() else HTTPStatus.FORBIDDEN
            self.write_json(run_codex_installer("install"), status=status)
            return
        if self.path == "/runtimes/codex/upgrade":
            status = HTTPStatus.OK if maintenance_mode() else HTTPStatus.FORBIDDEN
            self.write_json(run_codex_installer("upgrade"), status=status)
            return
        if self.path == "/runtimes/codex/run":
            self.write_json(run_codex_task(self.read_json()))
            return
        if self.path == "/runtimes/docker-sandbox/codex/run":
            self.write_json(run_sandbox_codex_task(self.read_json()))
            return
        if self.path == "/runtimes/docker-sandbox/policy":
            self.write_json(set_docker_sandbox_policy(self.read_json()))
            return
        if self.path.startswith("/runtimes/codex/kill/"):
            token = self.path[len("/runtimes/codex/kill/"):]
            killed = _job_kill(token)
            self.write_json({"ok": killed, "token": token})
            return
        if self.path == "/repositories/discover":
            self.write_json(discover_repositories(self.read_json()))
            return
        if self.path == "/mcp/add":
            self.write_json(mcp_add(self.read_json()))
            return
        if self.path.startswith("/mcp/remove/"):
            name = self.path[len("/mcp/remove/"):]
            self.write_json(mcp_remove(name))
            return
        self.write_json({"error": "Not found"}, status=HTTPStatus.NOT_FOUND)

    def log_message(self, format: str, *args: Any) -> None:
        message = format % args
        if "GET /logs" not in message:
            log_event("debug", message, client=self.address_string())

    def read_json(self) -> dict[str, Any]:
        content_length = int(self.headers.get("Content-Length", "0"))
        if content_length == 0:
            return {}
        body = self.rfile.read(content_length)
        try:
            return json.loads(body.decode("utf-8"))
        except json.JSONDecodeError:
            return {}

    def write_json(self, payload: dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    if HOST not in {"127.0.0.1", "localhost"}:
        raise SystemExit("Host runner must bind to localhost only.")

    server = ThreadingHTTPServer((HOST, PORT), HostRunnerHandler)
    mode = "maintenance" if maintenance_mode() else "safe"
    log_event("info", f"Specter Host Runner listening on http://{HOST}:{PORT}", mode=mode)
    server.serve_forever()


if __name__ == "__main__":
    main()
