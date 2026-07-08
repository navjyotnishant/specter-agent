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


HOST_RUNNER_VERSION = "1.1.0"

HOST = os.environ.get("SPECTER_HOST_RUNNER_HOST", "127.0.0.1")
PORT = int(os.environ.get("SPECTER_HOST_RUNNER_PORT", "8765"))
MAINTENANCE_MODE = os.environ.get("SPECTER_HOST_RUNNER_ENABLE_INSTALL") == "1"
CODEX_INSTALL_URL = "https://chatgpt.com/codex/install.sh"
CODEX_NPM_LATEST_URL = "https://registry.npmjs.org/@openai%2Fcodex/latest"
DOCKER_SANDBOX_CODEX_DOCS_URL = "https://docs.docker.com/ai/sandboxes/agents/codex/"
DOCKER_SANDBOX_PRODUCT_URL = "https://www.docker.com/products/docker-sandboxes/"
DOCKER_SANDBOX_TEMPLATE = "docker/sandbox-templates:codex"
SANDBOX_POLICY_VALUES = {"allow-all", "balanced", "deny-all"}
# Resolved at startup so launchd's minimal PATH doesn't cause FileNotFoundError
SBX = shutil.which("sbx") or "/opt/homebrew/bin/sbx"

# Registry of supported sandbox agents.
# Each entry describes how to launch the agent inside sbx.
# run_cmd: the keyword passed to `sbx run <run_cmd>`
# auth_provider: secret provider name for `sbx secret set -g <auth_provider>`
# auth_flag: extra flag on the secret set command (e.g. --oauth), or None
_SANDBOX_AGENTS: dict[str, dict[str, Any]] = {
    "codex": {
        "key": "codex",
        "display_name": "Codex",
        "template": "docker/sandbox-templates:codex",
        "run_cmd": "codex",
        "auth_provider": "openai",
        "auth_flag": "--oauth",
        # exec_args: command run inside sandbox via `sbx exec <name> <exec_args> -- <prompt_args>`
        "exec_args": lambda p: ["codex", "exec", "--sandbox", "read-only", "--json", p],
        "docs_url": "https://docs.docker.com/ai/sandboxes/agents/codex/",
    },
    "claude": {
        "key": "claude",
        "display_name": "Claude Code",
        "template": "docker/sandbox-templates:claude-code",
        "run_cmd": "claude",
        "auth_provider": "anthropic",
        "auth_flag": None,
        "exec_args": lambda p: ["claude", "--dangerously-skip-permissions", "-p", p],
        "docs_url": "https://docs.docker.com/ai/sandboxes/agents/claude-code/",
    },
    "cursor": {
        "key": "cursor",
        "display_name": "Cursor",
        "template": "docker/sandbox-templates:cursor",
        "run_cmd": "cursor",
        "auth_provider": None,  # OAuth proxy-managed; first run prompts browser login via sbx run cursor
        "auth_flag": None,
        "exec_args": lambda p: ["cursor-agent", "--print", p],
        "docs_url": "https://docs.docker.com/ai/sandboxes/agents/cursor/",
    },
}
LOG_LOCK = threading.Lock()
RUNNER_LOGS: list[dict[str, Any]] = []
MAX_LOGS = 2000          # in-memory ring buffer
LOG_SEQ = 0              # monotonic sequence number for since= polling
LOG_FILE = Path("/tmp/specter-host-runner-events.jsonl")  # persistent log file
LOG_FILE_MAX_BYTES = 10 * 1024 * 1024  # 10 MB rotation threshold

LAUNCHD_LABEL = "com.specter-agent.host-runner"
LAUNCHD_PLIST_SRC = Path(__file__).parent / "com.specter-agent.host-runner.plist"
LAUNCHD_PLIST_DST = Path.home() / "Library" / "LaunchAgents" / "com.specter-agent.host-runner.plist"


def launchd_status() -> dict[str, Any]:
    """Check whether the launchd service is installed and running."""
    installed = LAUNCHD_PLIST_DST.exists()
    try:
        result = subprocess.run(
            ["launchctl", "print", f"gui/{os.getuid()}/{LAUNCHD_LABEL}"],
            capture_output=True, text=True, timeout=5, check=False,
        )
        running = result.returncode == 0
        pid_line = next((l for l in result.stdout.splitlines() if "pid" in l.lower()), "")
    except Exception:
        running = False
        pid_line = ""
    return {
        "installed": installed,
        "running": running,
        "plist_src": str(LAUNCHD_PLIST_SRC),
        "plist_dst": str(LAUNCHD_PLIST_DST),
        "pid_line": pid_line.strip(),
    }


def launchd_install() -> dict[str, Any]:
    """Generate a plist pointing directly to python3 + script and load via launchd."""
    script = Path(__file__).resolve()
    python3 = shutil.which("python3") or "/opt/homebrew/bin/python3"
    plist_content = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{python3}</string>
        <string>{script}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>{script.parent.parent}</string>
    <key>StandardOutPath</key>
    <string>/tmp/specter-host-runner.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/specter-host-runner.log</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
</dict>
</plist>
"""
    try:
        LAUNCHD_PLIST_DST.parent.mkdir(parents=True, exist_ok=True)
        LAUNCHD_PLIST_DST.write_text(plist_content)
        result = subprocess.run(
            ["launchctl", "load", "-w", str(LAUNCHD_PLIST_DST)],
            capture_output=True, text=True, timeout=10, check=False,
        )
        if result.returncode != 0:
            return {"ok": False, "message": f"launchctl load failed: {result.stderr.strip() or result.stdout.strip()}"}
        return {"ok": True, "message": "Host runner service installed and loaded. It will start automatically on login."}
    except Exception as exc:
        return {"ok": False, "message": str(exc)}


def launchd_uninstall() -> dict[str, Any]:
    """Unload and remove the plist from LaunchAgents."""
    try:
        subprocess.run(
            ["launchctl", "unload", "-w", str(LAUNCHD_PLIST_DST)],
            capture_output=True, text=True, timeout=10, check=False,
        )
        if LAUNCHD_PLIST_DST.exists():
            LAUNCHD_PLIST_DST.unlink()
        return {"ok": True, "message": "Host runner service removed. It will no longer start automatically."}
    except Exception as exc:
        return {"ok": False, "message": str(exc)}


def launchd_restart() -> dict[str, Any]:
    """Restart the launchd service (or just exit so launchd revives it)."""
    status = launchd_status()
    if status["installed"] and status["running"]:
        try:
            result = subprocess.run(
                ["launchctl", "kickstart", "-k", f"gui/{os.getuid()}/{LAUNCHD_LABEL}"],
                capture_output=True, text=True, timeout=10, check=False,
            )
            if result.returncode == 0:
                return {"ok": True, "message": "Host runner restarted via launchd."}
        except Exception:
            pass
    # Fallback: exit this process — launchd KeepAlive will revive it
    def _exit() -> None:
        import time as _t; _t.sleep(0.3); os._exit(0)
    threading.Thread(target=_exit, daemon=True).start()
    return {"ok": True, "message": "Host runner restarting…"}


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
    if line.strip():
        log_event("info", line.strip(), job_token=token)


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
    global LOG_SEQ
    with LOG_LOCK:
        LOG_SEQ += 1
        seq = LOG_SEQ
    entry = {
        "seq": seq,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "level": level,
        "message": message,
        "metadata": {k: v for k, v in metadata.items() if v is not None and v != ""},
    }
    with LOG_LOCK:
        RUNNER_LOGS.append(entry)
        del RUNNER_LOGS[:-MAX_LOGS]
    # Persist to file with rotation
    try:
        if LOG_FILE.exists() and LOG_FILE.stat().st_size > LOG_FILE_MAX_BYTES:
            rotated = LOG_FILE.with_suffix(".1.jsonl")
            LOG_FILE.rename(rotated)
        with LOG_FILE.open("a") as fh:
            fh.write(json.dumps(entry) + "\n")
    except Exception:
        pass
    print(f"[{entry['timestamp']}] {level.upper():5} #{seq:06d} {message}", flush=True)


def get_logs(since: int = 0, level: str | None = None, limit: int = 200) -> dict[str, Any]:
    with LOG_LOCK:
        logs = list(RUNNER_LOGS)
    if since:
        logs = [e for e in logs if e.get("seq", 0) > since]
    if level:
        logs = [e for e in logs if e.get("level") == level]
    logs = logs[-limit:]
    latest_seq = logs[-1]["seq"] if logs else since
    return {"logs": logs, "count": len(logs), "latest_seq": latest_seq, "total": LOG_SEQ}


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
        # sbx version exits with code 1 but still prints the version to stderr
        result = subprocess.run(
            [executable, "version"],
            capture_output=True, text=True, timeout=5, check=False,
        )
        version = (result.stdout or result.stderr).strip() or version

        # Check daemon health via `sbx daemon status` — reliable and independent of version output format
        daemon_result = subprocess.run(
            [executable, "daemon", "status"],
            capture_output=True, text=True, timeout=5, check=False,
        )
        daemon_output = (daemon_result.stdout + daemon_result.stderr).lower()
        daemon_available = daemon_result.returncode == 0 and "running" in daemon_output

        status = "ok" if daemon_available else "daemon_unavailable"
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


def sbx_configured_secrets(exe: str) -> set[str]:
    """Return the set of provider names that have a secret configured in sbx."""
    try:
        result = subprocess.run(
            [exe, "secret", "ls"],
            capture_output=True, text=True, timeout=8, check=False,
        )
        output = result.stdout + result.stderr
        configured: set[str] = set()
        for line in output.splitlines():
            parts = line.split()
            # output format: SCOPE  TYPE  NAME  SECRET
            # e.g.: (global)  service  openai  (oauth configured)
            if len(parts) >= 3:
                name = parts[2].lower()
                secret_val = " ".join(parts[3:]).lower()
                if name and "configured" in secret_val:
                    configured.add(name)
        return configured
    except Exception:
        return set()


def agent_auth_status(exe: str) -> list[dict[str, Any]]:
    """Return auth status for each configured sandbox agent."""
    configured = sbx_configured_secrets(exe)
    result = []
    for key, agent in _SANDBOX_AGENTS.items():
        provider = agent.get("auth_provider")
        auth_flag = agent.get("auth_flag")
        if provider is None:
            # OAuth managed automatically by sbx proxy — no secret required
            result.append({
                "key": key,
                "display_name": agent["display_name"],
                "auth_provider": None,
                "authenticated": True,
                "auth_command": None,
                "auth_note": "OAuth managed automatically by sbx proxy on first run.",
            })
        else:
            has_secret = provider in configured
            auth_cmd = f"sbx secret set -g {provider}" + (f" {auth_flag}" if auth_flag else "")
            result.append({
                "key": key,
                "display_name": agent["display_name"],
                "auth_provider": provider,
                "authenticated": has_secret,
                "auth_command": auth_cmd,
            })
    return result


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
            "supported_agents": [{k: v for k, v in a.items() if k != "exec_args"} for a in _SANDBOX_AGENTS.values()],
            "message": "Docker Sandboxes CLI is not installed. Install sbx to use isolated local agent execution.",
        }

    version = best["version"]
    daemon_available = bool(best.get("daemon_available"))
    healthy = best.get("status") == "ok" and daemon_available
    health_status = "cli_available" if healthy else "daemon_unavailable"
    agent_auth = agent_auth_status(best["path"]) if healthy else []
    unauthenticated = [a for a in agent_auth if not a["authenticated"]]
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
        "agent_auth": agent_auth,
        "unauthenticated_agents": [a["key"] for a in unauthenticated],
        "install_guidance": install_guidance,
        "recommended_runtime": "docker-sandbox" if healthy else "codex-cli",
        "base_image": DOCKER_SANDBOX_TEMPLATE,
        "runner_mode": runner_mode_value,
        "supported_agents": [{k: v for k, v in a.items() if k != "exec_args"} for a in _SANDBOX_AGENTS.values()],
        "message": (
            "Docker Sandboxes is ready for isolated local execution."
            if healthy
            else "Docker Sandboxes CLI is installed, but the sandbox daemon is not reachable. Run sbx daemon start."
        ),
    }


def sbx_daemon_start() -> dict[str, Any]:
    """Start the sbx daemon in the background."""
    try:
        result = subprocess.run(
            [SBX, "daemon", "start"],
            capture_output=True, text=True, timeout=15, check=False,
        )
        if result.returncode == 0:
            log_event("info", "sbx daemon started", stdout=result.stdout.strip())
            return {"ok": True, "message": "sbx daemon started successfully."}
        # Already running is not an error
        combined = (result.stdout + result.stderr).lower()
        if "already" in combined or "running" in combined:
            return {"ok": True, "message": "sbx daemon is already running."}
        return {"ok": False, "message": result.stderr.strip() or result.stdout.strip() or "sbx daemon start failed."}
    except subprocess.TimeoutExpired:
        return {"ok": False, "message": "sbx daemon start timed out."}
    except Exception as exc:
        return {"ok": False, "message": str(exc)}


def docker_sandbox_policy_status() -> dict[str, Any]:
    if not best_sbx_candidate()[0]:
        return {
            "ok": False,
            "status": "missing",
            "current_policy": None,
            "available_policies": sorted(SANDBOX_POLICY_VALUES),
            "message": "Docker Sandboxes CLI is not installed.",
        }

    result = subprocess.run([SBX, "policy", "ls"], capture_output=True, text=True, timeout=10, check=False)
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
            reset = subprocess.run([SBX, "policy", "reset", "--force"], capture_output=True, text=True, timeout=45, check=False)
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

    result = subprocess.run([SBX, "policy", "set-default", policy], capture_output=True, text=True, timeout=30, check=False)
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
    """Backward-compat shim — routes to the generic agent task runner."""
    return run_sandbox_agent_task({**payload, "agent": "codex"})


def run_sandbox_agent_task(payload: dict[str, Any]) -> dict[str, Any]:
    import time as _time
    agent_key = str(payload.get("agent") or "codex").strip().lower()
    workspace_path = str(payload.get("workspace_path") or "").strip()
    prompt = str(payload.get("prompt") or "").strip()
    mode = str(payload.get("mode") or "read-only").strip()
    timeout_seconds = int(payload.get("timeout_seconds") or 180)
    job_token = str(payload.get("job_token") or "")

    agent = _SANDBOX_AGENTS.get(agent_key)
    if not agent:
        return {"ok": False, "status": "rejected", "message": f"Unsupported sandbox agent: {agent_key!r}. Supported: {', '.join(_SANDBOX_AGENTS)}"}
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
    run_cmd = agent["run_cmd"]

    # sbx run is interactive/TTY-only and doesn't stream output when piped.
    # Use sbx create + sbx exec: create sets up the microVM, exec runs non-interactively and streams JSON.
    create_command = [SBX, "create", "--clone", "--name", sandbox_name, run_cmd, str(workspace)]
    exec_command = [SBX, "exec", sandbox_name, *agent["exec_args"](prompt)]

    all_stdout_lines: list[str] = []
    stderr_buf: list[str] = []
    timed_out = False
    proc: subprocess.Popen[str] | None = None
    deadline = _time.monotonic() + timeout_seconds

    def stream_command(command: list[str], label: str) -> int | None:
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

    display_name = agent["display_name"]
    log_event("info", f"Starting Docker Sandbox {display_name} task", workspace=str(workspace), sandbox=sandbox_name, agent=agent_key, timeout_seconds=timeout_seconds)

    try:
        create_exit = stream_command(create_command, f"[sandbox] creating {display_name} sandbox")
        if create_exit != 0 or timed_out:
            raise RuntimeError(f"Sandbox creation failed (exit {create_exit})")
        exec_exit = stream_command(exec_command, f"[sandbox] running {display_name}")
    except Exception as exc:
        if job_token:
            _job_done(job_token)
        return {"ok": False, "status": "error", "message": str(exc), "stdout": "", "stderr": "", "final_message": ""}
    finally:
        cleanup = subprocess.run([SBX, "rm", "--force", sandbox_name], capture_output=True, text=True, timeout=30, check=False)
        if cleanup and cleanup.returncode != 0:
            log_event("warn", "Docker Sandbox cleanup failed", sandbox=sandbox_name, stderr=cleanup.stderr[-1000:])
        if job_token:
            _job_done(job_token)

    stdout_text = "\n".join(all_stdout_lines)
    stderr_text = "\n".join(stderr_buf)
    if timed_out:
        log_event("error", f"Docker Sandbox {display_name} task timed out", workspace=str(workspace), sandbox=sandbox_name, timeout_seconds=timeout_seconds)
        return {
            "ok": False,
            "status": "timeout",
            "message": f"Docker Sandbox {display_name} task timed out.",
            "exit_code": None,
            "stdout": stdout_text[-20000:],
            "stderr": stderr_text[-12000:],
            "final_message": extract_codex_final_message(stdout_text),
            "metadata": {"workspace_path": str(workspace), "mode": mode, "timeout_seconds": timeout_seconds, "sandbox_name": sandbox_name, "runtime_id": "docker-sandbox", "agent": agent_key},
        }

    ok = exec_exit == 0

    # Detect auth errors before generic failure handling and surface actionable messages
    combined_output = stdout_text + stderr_text
    if not ok and "Not logged in" in combined_output:
        login_message = (
            f"Claude Code sandbox requires a one-time login. "
            f"Open a terminal and run:\n\n"
            f"  sbx run --name claude-login claude {workspace}\n\n"
            f"Then type /login inside the sandbox. "
            f"After logging in once, credentials persist across all future runs."
        )
        log_event("error", f"Docker Sandbox {display_name} — not logged in", workspace=str(workspace), sandbox=sandbox_name)
        return {
            "ok": False,
            "status": "auth_required",
            "message": login_message,
            "exit_code": exec_exit,
            "stdout": stdout_text[-20000:],
            "stderr": stderr_text[-12000:],
            "final_message": login_message,
            "metadata": {"workspace_path": str(workspace), "mode": mode, "timeout_seconds": timeout_seconds, "sandbox_name": sandbox_name, "runtime_id": "docker-sandbox", "agent": agent_key},
        }
    if not ok and "Authentication required" in combined_output:
        login_message = (
            f"Cursor sandbox requires a one-time login. "
            f"Open a terminal and run:\n\n"
            f"  sbx run --name cursor-login cursor {workspace}\n\n"
            f"Sign in via the browser when prompted. "
            f"After logging in once, credentials persist across all future runs."
        )
        log_event("error", f"Docker Sandbox {display_name} — not logged in", workspace=str(workspace), sandbox=sandbox_name)
        return {
            "ok": False,
            "status": "auth_required",
            "message": login_message,
            "exit_code": exec_exit,
            "stdout": stdout_text[-20000:],
            "stderr": stderr_text[-12000:],
            "final_message": login_message,
            "metadata": {"workspace_path": str(workspace), "mode": mode, "timeout_seconds": timeout_seconds, "sandbox_name": sandbox_name, "runtime_id": "docker-sandbox", "agent": agent_key},
        }

    final_message = extract_codex_final_message(stdout_text)
    error_message = extract_codex_error_message(stdout_text)
    log_event(
        "info" if ok else "error",
        f"Docker Sandbox {display_name} task {'completed' if ok else 'failed'}",
        workspace=str(workspace),
        sandbox=sandbox_name,
        exit_code=exec_exit,
    )
    return {
        "ok": ok,
        "status": "completed" if ok else "failed",
        "message": f"Docker Sandbox {display_name} task completed." if ok else error_message or f"Docker Sandbox {display_name} task failed.",
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
            "agent": agent_key,
            "command": f"sbx create --clone --name {sandbox_name} {run_cmd} && sbx exec {sandbox_name}",
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


# ── Direct CLI agent registry ────────────────────────────────────────────────
# Each entry describes how to run the agent directly on the host (no sandbox).
# cmd_fn: returns the subprocess command given (executable, workspace_str, prompt)
# check_auth_fn: returns (authenticated: bool, note: str) for health reporting
# install_check: callable that returns path or None

def _claude_path() -> str | None:
    return shutil.which("claude")

def _cursor_agent_path() -> str | None:
    return shutil.which("cursor-agent") or shutil.which("cursor")

def _check_claude_auth() -> tuple[bool, str]:
    exe = _claude_path()
    if not exe:
        return False, "claude not found on PATH"
    try:
        result = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=5, check=False)
        # Try a no-op to detect auth state
        auth_result = subprocess.run(
            [exe, "--dangerously-skip-permissions", "-p", "ping"],
            capture_output=True, text=True, timeout=10, check=False,
            cwd=str(Path.home()),
        )
        combined = auth_result.stdout + auth_result.stderr
        if "Not logged in" in combined or "Login required" in combined or "authenticate" in combined.lower():
            return False, "Not logged in — run: claude /login"
        return True, "Logged in"
    except Exception as exc:
        return False, str(exc)

def _check_cursor_auth() -> tuple[bool, str]:
    exe = _cursor_agent_path()
    if not exe:
        return False, "cursor-agent not found on PATH"
    try:
        auth_result = subprocess.run(
            [exe, "--trust", "--print", "ping"],
            capture_output=True, text=True, timeout=10, check=False,
            cwd=str(Path.home()),
        )
        combined = auth_result.stdout + auth_result.stderr
        if "Authentication required" in combined or "not logged in" in combined.lower() or "sign in" in combined.lower():
            return False, "Not logged in — open Cursor and sign in"
        return True, "Logged in"
    except Exception as exc:
        return False, str(exc)

_DIRECT_CLI_AGENTS: dict[str, dict[str, Any]] = {
    "codex": {
        "key": "codex",
        "display_name": "Codex",
        "binary": "codex",
        "find_exe": lambda: shutil.which("codex") or str(next((p for p in [
            Path.home() / ".local/bin/codex",
            Path("/opt/homebrew/bin/codex"),
            Path("/usr/local/bin/codex"),
        ] if p.exists()), Path("codex"))),
        "cmd_fn": lambda exe, ws, p: [exe, "exec", "--cd", ws, "--sandbox", "read-only", "--json", "--color", "never", p],
        "check_auth": lambda: (bool(shutil.which("codex") or any(
            Path(p).exists() for p in [str(Path.home() / ".local/bin/codex"), "/opt/homebrew/bin/codex", "/usr/local/bin/codex"]
        )), "Sign in via: codex"),
        "auth_note": "Run `codex` once and sign in with your OpenAI account.",
        "docs_url": "https://github.com/openai/codex",
    },
    "claude": {
        "key": "claude",
        "display_name": "Claude Code",
        "binary": "claude",
        "find_exe": _claude_path,
        "cmd_fn": lambda exe, ws, p: [exe, "--dangerously-skip-permissions", "-p", p],
        "check_auth": _check_claude_auth,
        "auth_note": "Run `claude /login` in your terminal to authenticate.",
        "docs_url": "https://docs.anthropic.com/claude-code",
    },
    "cursor": {
        "key": "cursor",
        "display_name": "Cursor",
        "binary": "cursor-agent",
        "find_exe": _cursor_agent_path,
        "cmd_fn": lambda exe, ws, p: [exe, "--trust", "--print", p],
        "check_auth": _check_cursor_auth,
        "auth_note": "Open Cursor and sign in to your account.",
        "docs_url": "https://docs.cursor.com",
    },
}


def direct_cli_agent_status() -> list[dict[str, Any]]:
    result = []
    for key, agent in _DIRECT_CLI_AGENTS.items():
        exe = agent["find_exe"]()
        installed = bool(exe and (Path(exe).exists() if exe != agent["binary"] else shutil.which(exe)))
        if installed:
            authenticated, auth_note = agent["check_auth"]()
        else:
            authenticated = False
            auth_note = f"{agent['binary']} not found on PATH. {agent['auth_note']}"
        version = None
        if installed and exe:
            try:
                vr = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=5, check=False)
                version = (vr.stdout or vr.stderr).strip().splitlines()[0] if (vr.stdout or vr.stderr).strip() else None
            except Exception:
                pass
        result.append({
            "key": key,
            "display_name": agent["display_name"],
            "installed": installed,
            "authenticated": authenticated,
            "version": version,
            "executable_path": str(exe) if exe else None,
            "auth_note": auth_note,
            "docs_url": agent["docs_url"],
        })
    return result


_DIRECT_CLI_STATUS_CACHE: dict[str, Any] = {}
_DIRECT_CLI_STATUS_CACHE_TS: float = 0.0
_DIRECT_CLI_STATUS_CACHE_TTL: float = 60.0


def direct_cli_status() -> dict[str, Any]:
    import time as _t
    global _DIRECT_CLI_STATUS_CACHE, _DIRECT_CLI_STATUS_CACHE_TS
    if _DIRECT_CLI_STATUS_CACHE and (_t.monotonic() - _DIRECT_CLI_STATUS_CACHE_TS) < _DIRECT_CLI_STATUS_CACHE_TTL:
        return _DIRECT_CLI_STATUS_CACHE
    agent_statuses = direct_cli_agent_status()
    any_ready = any(a["installed"] and a["authenticated"] for a in agent_statuses)
    all_missing = all(not a["installed"] for a in agent_statuses)
    result = {
        "runtime_id": "direct-cli",
        "display_name": "Direct CLI Runtime",
        "status": "ready" if any_ready else ("missing" if all_missing else "setup_required"),
        "available": any_ready,
        "installed": not all_missing,
        "agent_status": agent_statuses,
        "runner_mode": "maintenance" if maintenance_mode() else "safe",
        "message": (
            "Direct CLI is ready. Agents run directly on your host machine without sandbox isolation."
            if any_ready else
            "No Direct CLI agents are installed and authenticated. Install at least one agent to use Direct CLI."
        ),
    }
    _DIRECT_CLI_STATUS_CACHE = result
    _DIRECT_CLI_STATUS_CACHE_TS = _t.monotonic()
    return result


def run_direct_cli_task(payload: dict[str, Any]) -> dict[str, Any]:
    import time as _time
    agent_key = str(payload.get("agent") or "codex").strip().lower()
    workspace_path = str(payload.get("workspace_path") or "").strip()
    prompt = str(payload.get("prompt") or "").strip()
    timeout_seconds = int(payload.get("timeout_seconds") or 120)
    job_token = str(payload.get("job_token") or "")

    agent = _DIRECT_CLI_AGENTS.get(agent_key)
    if not agent:
        return {"ok": False, "status": "rejected", "message": f"Unsupported direct CLI agent: {agent_key!r}. Supported: {', '.join(_DIRECT_CLI_AGENTS)}"}
    if not prompt:
        return {"ok": False, "status": "rejected", "message": "Prompt is required."}

    workspace = Path(workspace_path).expanduser().resolve()
    if not workspace.exists() or not workspace.is_dir():
        return {"ok": False, "status": "rejected", "message": "Workspace path does not exist or is not a directory."}

    exe = agent["find_exe"]()
    if not exe or not (Path(exe).exists() if "/" in str(exe) else shutil.which(exe)):
        return {"ok": False, "status": "missing", "message": f"{agent['display_name']} is not installed. {agent['auth_note']}"}

    if job_token:
        _job_create(job_token)

    command = agent["cmd_fn"](exe, str(workspace), prompt)
    display_name = agent["display_name"]
    log_event("info", f"Starting Direct CLI {display_name} task", workspace=str(workspace), timeout_seconds=timeout_seconds)

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
            cwd=str(workspace),
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

        deadline = _time.monotonic() + timeout_seconds
        for line in proc.stdout:  # type: ignore[union-attr]
            line = line.rstrip()
            all_stdout_lines.append(line)
            if job_token:
                if agent_key == "codex":
                    append_codex_progress(job_token, line)
                elif line.strip():
                    _job_append(job_token, line.strip()[:2000])
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

    stdout_text = "\n".join(all_stdout_lines)
    stderr_text = "\n".join(stderr_buf)

    if timed_out:
        log_event("error", f"Direct CLI {display_name} task timed out", workspace=str(workspace), timeout_seconds=timeout_seconds)
        return {
            "ok": False,
            "status": "timeout",
            "message": f"{display_name} task timed out after {timeout_seconds}s.",
            "exit_code": None,
            "stdout": stdout_text[-20000:],
            "stderr": stderr_text[-12000:],
            "final_message": extract_codex_final_message(stdout_text) if agent_key == "codex" else stdout_text[-4000:],
            "metadata": {"workspace_path": str(workspace), "timeout_seconds": timeout_seconds, "agent": agent_key, "runtime": "direct"},
        }

    # Auth error detection
    combined = stdout_text + stderr_text
    ok = proc.returncode == 0
    if not ok and ("Not logged in" in combined or "Login required" in combined):
        return {
            "ok": False,
            "status": "auth_required",
            "message": f"{display_name} is not logged in. {agent['auth_note']}",
            "exit_code": proc.returncode,
            "stdout": stdout_text[-20000:],
            "stderr": stderr_text[-12000:],
            "final_message": f"{display_name} requires authentication. {agent['auth_note']}",
            "metadata": {"workspace_path": str(workspace), "agent": agent_key, "runtime": "direct"},
        }
    if not ok and ("Authentication required" in combined or "sign in" in combined.lower()):
        return {
            "ok": False,
            "status": "auth_required",
            "message": f"{display_name} requires authentication. {agent['auth_note']}",
            "exit_code": proc.returncode,
            "stdout": stdout_text[-20000:],
            "stderr": stderr_text[-12000:],
            "final_message": f"{display_name} requires authentication. {agent['auth_note']}",
            "metadata": {"workspace_path": str(workspace), "agent": agent_key, "runtime": "direct"},
        }

    if agent_key == "codex":
        final_message = extract_codex_final_message(stdout_text) or extract_codex_error_message(stdout_text)
    else:
        clean = [l for l in stdout_text.splitlines() if l.strip() and not l.strip().startswith("{")]
        final_message = "\n".join(clean[-80:]).strip() or stdout_text[-4000:]

    log_event(
        "info" if ok else "error",
        f"Direct CLI {display_name} task {'completed' if ok else 'failed'}",
        workspace=str(workspace),
        exit_code=proc.returncode,
    )
    return {
        "ok": ok,
        "status": "completed" if ok else "failed",
        "message": f"Direct CLI {display_name} task {'completed' if ok else 'failed'}.",
        "exit_code": proc.returncode,
        "stdout": stdout_text[-20000:],
        "stderr": stderr_text[-12000:],
        "final_message": final_message,
        "metadata": {"workspace_path": str(workspace), "timeout_seconds": timeout_seconds, "agent": agent_key, "runtime": "direct"},
    }


# ── MCP catalog ──────────────────────────────────────────────────────────────
# Each entry has an optional "clients" list — if present, only those adapters
# show the entry. Absent means shown to all clients.
MCP_CATALOG: list[dict[str, Any]] = [
    # ── stdio servers (both clients) ──────────────────────────────────────────
    {
        "id": "filesystem", "name": "filesystem", "display_name": "Filesystem",
        "description": "Read and write files on the local filesystem within approved paths.",
        "auth_type": "none", "transport_type": "stdio",
        "add_command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/"],
        "docs_url": "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    },
    {
        "id": "github", "name": "github", "display_name": "GitHub",
        "description": "Search repos, read files, manage issues and PRs via the GitHub API.",
        "auth_type": "token", "token_env_var": "GITHUB_TOKEN",
        "token_label": "GitHub Personal Access Token",
        "transport_type": "stdio",
        "add_command": ["npx", "-y", "@modelcontextprotocol/server-github"],
        "docs_url": "https://github.com/modelcontextprotocol/servers/tree/main/src/github",
    },
    {
        "id": "postgres", "name": "postgres", "display_name": "PostgreSQL",
        "description": "Run read-only SQL queries against a PostgreSQL database.",
        "auth_type": "token", "token_env_var": "POSTGRES_CONNECTION_STRING",
        "token_label": "Postgres connection string (postgresql://user:pass@host/db)",
        "transport_type": "stdio",
        "add_command": ["npx", "-y", "@modelcontextprotocol/server-postgres"],
        "docs_url": "https://github.com/modelcontextprotocol/servers/tree/main/src/postgres",
    },
    {
        "id": "brave-search", "name": "brave-search", "display_name": "Brave Search",
        "description": "Web and local search powered by the Brave Search API.",
        "auth_type": "token", "token_env_var": "BRAVE_API_KEY",
        "token_label": "Brave Search API Key",
        "transport_type": "stdio",
        "add_command": ["npx", "-y", "@modelcontextprotocol/server-brave-search"],
        "docs_url": "https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search",
    },
    {
        "id": "slack", "name": "slack", "display_name": "Slack",
        "description": "Read channels, post messages, and search Slack workspaces.",
        "auth_type": "token", "token_env_var": "SLACK_BOT_TOKEN",
        "token_label": "Slack Bot Token (xoxb-...)",
        "transport_type": "stdio",
        "add_command": ["npx", "-y", "@modelcontextprotocol/server-slack"],
        "docs_url": "https://github.com/modelcontextprotocol/servers/tree/main/src/slack",
    },
    # ── HTTP/OAuth servers (both clients) ─────────────────────────────────────
    {
        "id": "figma", "name": "figma", "display_name": "Figma",
        "description": "Read Figma designs, components, and assets.",
        "auth_type": "oauth", "transport_type": "streamable_http",
        "url": "https://mcp.figma.com/mcp",
        "docs_url": "https://www.figma.com/developers/mcp",
    },
    {
        "id": "linear", "name": "linear", "display_name": "Linear",
        "description": "Create and update Linear issues, projects, and cycles.",
        "auth_type": "oauth", "transport_type": "streamable_http",
        "url": "https://mcp.linear.app/mcp",
        "docs_url": "https://linear.app/docs/mcp",
    },
    {
        "id": "notion", "name": "notion", "display_name": "Notion",
        "description": "Read and write Notion pages and databases.",
        "auth_type": "oauth", "transport_type": "streamable_http",
        "url": "https://mcp.notion.com/mcp",
        "docs_url": "https://developers.notion.com/docs/mcp",
    },
    {
        "id": "stripe", "name": "stripe", "display_name": "Stripe",
        "description": "Manage payments, customers, and subscriptions via Stripe.",
        "auth_type": "oauth", "transport_type": "streamable_http",
        "url": "https://mcp.stripe.com",
        "docs_url": "https://docs.stripe.com/mcp",
    },
    # ── Claude Code marketplace servers (claude-code only) ────────────────────
    {
        "id": "claude-ai-gmail", "name": "claude.ai Gmail", "display_name": "Gmail",
        "description": "Read, search, draft, and label Gmail messages.",
        "auth_type": "oauth", "transport_type": "streamable_http",
        "url": "https://gmailmcp.googleapis.com/mcp/v1",
        "docs_url": "https://developers.google.com/workspace",
        "clients": ["claude-code"],
    },
    {
        "id": "claude-ai-google-drive", "name": "claude.ai Google Drive", "display_name": "Google Drive",
        "description": "Search, read, and create files in Google Drive.",
        "auth_type": "oauth", "transport_type": "streamable_http",
        "url": "https://drivemcp.googleapis.com/mcp/v1",
        "docs_url": "https://developers.google.com/workspace",
        "clients": ["claude-code"],
    },
    {
        "id": "claude-ai-google-calendar", "name": "claude.ai Google Calendar", "display_name": "Google Calendar",
        "description": "Read and create Google Calendar events.",
        "auth_type": "oauth", "transport_type": "streamable_http",
        "url": "https://calendarmcp.googleapis.com/mcp/v1",
        "docs_url": "https://developers.google.com/workspace",
        "clients": ["claude-code"],
    },
    {
        "id": "claude-ai-canva", "name": "claude.ai Canva", "display_name": "Canva",
        "description": "Create and edit Canva designs from Claude.",
        "auth_type": "oauth", "transport_type": "streamable_http",
        "url": "https://mcp.canva.com/mcp",
        "docs_url": "https://www.canva.com/developers",
        "clients": ["claude-code"],
    },
    {
        "id": "claude-ai-gamma", "name": "claude.ai Gamma", "display_name": "Gamma",
        "description": "Generate AI-powered presentations and documents.",
        "auth_type": "oauth", "transport_type": "streamable_http",
        "url": "https://mcp.gamma.app/mcp",
        "docs_url": "https://gamma.app",
        "clients": ["claude-code"],
    },
    {
        "id": "claude-ai-atlassian", "name": "claude.ai Atlassian Rovo", "display_name": "Atlassian Rovo",
        "description": "Search Confluence, Jira, and Atlassian tools via Rovo.",
        "auth_type": "oauth", "transport_type": "streamable_http",
        "url": "https://mcp.atlassian.com/v1/mcp",
        "docs_url": "https://www.atlassian.com/rovo",
        "clients": ["claude-code"],
    },
    {
        "id": "claude-ai-microsoft-learn", "name": "claude.ai Microsoft Learn", "display_name": "Microsoft Learn",
        "description": "Search and fetch official Microsoft and Azure documentation.",
        "auth_type": "none", "transport_type": "streamable_http",
        "url": "https://learn.microsoft.com/api/mcp",
        "docs_url": "https://learn.microsoft.com",
        "clients": ["claude-code"],
    },
    {
        "id": "claude-ai-godaddy", "name": "claude.ai GoDaddy", "display_name": "GoDaddy",
        "description": "Check domain availability and get domain suggestions.",
        "auth_type": "oauth", "transport_type": "streamable_http",
        "url": "https://api.godaddy.com/v1/domains/mcp",
        "docs_url": "https://developer.godaddy.com",
        "clients": ["claude-code"],
    },
    {
        "id": "claude-ai-krisp", "name": "claude.ai KRISP", "display_name": "KRISP",
        "description": "Access meeting notes, transcripts, and action items from Krisp.",
        "auth_type": "oauth", "transport_type": "streamable_http",
        "url": "https://mcp.krisp.ai/mcp",
        "docs_url": "https://krisp.ai",
        "clients": ["claude-code"],
    },
]


# ── MCP client adapters ───────────────────────────────────────────────────────

class McpClientAdapter:
    """Base class — subclasses implement per-client config read/write."""

    client_id: str = ""
    display_name: str = ""

    def list_configured(self) -> dict[str, Any]:
        """Return dict of name → live config for servers already configured."""
        return {}

    def add(self, payload: dict[str, Any]) -> dict[str, Any]:
        return {"ok": False, "message": f"add() not implemented for {self.client_id}"}

    def remove(self, name: str) -> dict[str, Any]:
        return {"ok": False, "message": f"remove() not implemented for {self.client_id}"}

    def login_instructions(self, name: str) -> dict[str, Any]:
        return {"ok": False, "message": f"OAuth login not supported for {self.client_id}"}

    # ── shared catalog merge ───────────────────────────────────────────────────
    def build_server_list(self) -> dict[str, Any]:
        configured = self.list_configured()
        # filter catalog to entries that support this client
        client_catalog = [
            e for e in MCP_CATALOG
            if "clients" not in e or self.client_id in e["clients"]
        ]
        # build URL→live lookup so we can match by URL when name doesn't align
        url_to_live: dict[str, Any] = {}
        for live in configured.values():
            url = live.get("transport", {}).get("url", "")
            if url:
                url_to_live[url.rstrip("/")] = live

        matched_live_names: set[str] = set()
        merged: list[dict[str, Any]] = []
        for entry in client_catalog:
            live = configured.get(entry["name"])
            # fallback: match by URL for clients that rename servers (e.g. "claude.ai Figma")
            if not live and entry.get("url"):
                live = url_to_live.get(entry["url"].rstrip("/"))
            if live:
                matched_live_names.add(live.get("name", ""))
                merged.append({
                    **entry,
                    "configured": True, "live": live,
                    "auth_status": live.get("auth_status", "active"),
                    "enabled": live.get("enabled", True),
                })
            else:
                merged.append({**entry, "configured": False, "live": None, "auth_status": None, "enabled": False})
        # include extra configured servers not matched to any catalog entry
        catalog_names = {e["name"] for e in client_catalog}
        for name, live in configured.items():
            if name not in catalog_names and name not in matched_live_names:
                merged.append({
                    "id": name, "name": name, "display_name": name,
                    "description": "Custom MCP server.",
                    "auth_type": "unknown",
                    "transport_type": live.get("transport", {}).get("type", "unknown"),
                    "configured": True, "live": live,
                    "auth_status": live.get("auth_status", "active"),
                    "enabled": live.get("enabled", True),
                })
        return {"ok": True, "client": self.client_id, "servers": merged}


class CodexMcpAdapter(McpClientAdapter):
    client_id = "codex"
    display_name = "Codex"

    def _codex(self) -> str | None:
        best, _ = best_codex_candidate()
        return best["path"] if best else None

    def list_configured(self) -> dict[str, Any]:
        exe = self._codex()
        if not exe:
            return {}
        try:
            result = subprocess.run(
                [exe, "mcp", "list", "--json"],
                capture_output=True, text=True, timeout=10, check=False,
            )
            servers = json.loads(result.stdout) if result.returncode == 0 else []
            return {s["name"]: s for s in servers}
        except Exception as exc:
            log_event("warn", "codex mcp list failed", error=str(exc))
            return {}

    def add(self, payload: dict[str, Any]) -> dict[str, Any]:
        exe = self._codex()
        if not exe:
            return {"ok": False, "message": "Codex CLI not installed."}
        name = str(payload.get("name") or "").strip()
        transport_type = str(payload.get("transport_type") or "stdio")
        url = str(payload.get("url") or "").strip()
        command = payload.get("command") or []
        env_vars = payload.get("env_vars") or {}
        if not name:
            return {"ok": False, "message": "Name is required."}
        cmd = [exe, "mcp", "add", name]
        if transport_type == "streamable_http":
            if not url:
                return {"ok": False, "message": "URL required for HTTP transport."}
            cmd += ["--url", url]
        else:
            if not command:
                return {"ok": False, "message": "Command required for stdio transport."}
            cmd += ["--"] + [str(c) for c in command]
        for k, v in env_vars.items():
            cmd += ["--env", f"{k}={v}"]
        log_event("info", f"[codex] Adding MCP server: {name}")
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30, check=False)
            ok = result.returncode == 0
            log_event("info" if ok else "warn", f"[codex] MCP add '{name}'", exit_code=result.returncode)
            return {
                "ok": ok, "name": name,
                "message": f"'{name}' added to Codex." if ok else f"Failed: {result.stderr.strip()}",
            }
        except Exception as exc:
            return {"ok": False, "name": name, "message": str(exc)}

    def remove(self, name: str) -> dict[str, Any]:
        exe = self._codex()
        if not exe:
            return {"ok": False, "message": "Codex CLI not installed."}
        try:
            result = subprocess.run(
                [exe, "mcp", "remove", name],
                capture_output=True, text=True, timeout=15, check=False,
            )
            ok = result.returncode == 0
            log_event("info" if ok else "warn", f"[codex] MCP remove '{name}'", exit_code=result.returncode)
            return {"ok": ok, "name": name, "message": f"Removed '{name}'." if ok else result.stderr.strip()}
        except Exception as exc:
            return {"ok": False, "name": name, "message": str(exc)}

    def login_instructions(self, name: str) -> dict[str, Any]:
        if not self._codex():
            return {"ok": False, "message": "Codex CLI not installed."}
        return {
            "ok": True, "name": name, "requires_terminal": True,
            "command": f"codex mcp login {name}",
            "message": f"Run `codex mcp login {name}` in your terminal. A browser window will open.",
        }


class ClaudeCodeMcpAdapter(McpClientAdapter):
    client_id = "claude-code"
    display_name = "Claude Code"

    _SETTINGS_PATH = Path.home() / ".claude" / "settings.json"

    def _read_settings(self) -> dict[str, Any]:
        try:
            return json.loads(self._SETTINGS_PATH.read_text()) if self._SETTINGS_PATH.exists() else {}
        except Exception:
            return {}

    def _write_settings(self, data: dict[str, Any]) -> None:
        self._SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
        self._SETTINGS_PATH.write_text(json.dumps(data, indent=2))

    def _claude_exe(self) -> str | None:
        # shutil.which only works when PATH is fully set; launchd has a minimal PATH
        # so check common install locations explicitly as fallback
        for candidate in [
            shutil.which("claude"),
            "/opt/homebrew/bin/claude",
            str(Path.home() / ".npm-global" / "bin" / "claude"),
            str(Path.home() / ".local" / "bin" / "claude"),
            "/usr/local/bin/claude",
        ]:
            if candidate and Path(candidate).is_file():
                return candidate
        return None

    def list_configured(self) -> dict[str, Any]:
        result: dict[str, Any] = {}

        # Primary: parse `claude mcp list` output
        exe = self._claude_exe()
        if exe:
            try:
                proc = subprocess.run(
                    [exe, "mcp", "list"],
                    capture_output=True, text=True, timeout=15, check=False,
                )
                for line in proc.stdout.splitlines():
                    line = line.strip()
                    if not line or line.startswith("Checking"):
                        continue
                    # Format: "Display Name: url - status"  or  "name: url (transport) - status"
                    if ":" not in line:
                        continue
                    name_part, _, rest = line.partition(":")
                    name = name_part.strip()
                    url_part, _, status_part = rest.strip().partition(" - ")
                    url = url_part.strip().split(" ")[0]  # strip "(SSE)" etc.
                    connected = "Connected" in status_part
                    needs_auth = "Needs authentication" in status_part
                    auth_status = "active" if connected else ("needs_auth" if needs_auth else "unknown")
                    result[name] = {
                        "name": name,
                        "enabled": True,
                        "auth_status": auth_status,
                        "transport": {"type": "streamable_http", "url": url},
                    }
            except Exception as exc:
                log_event("warn", "[claude-code] claude mcp list failed", error=str(exc))

        # Fallback / supplement: read settings.json mcpServers
        settings = self._read_settings()
        for name, cfg in settings.get("mcpServers", {}).items():
            if name not in result:
                transport = "streamable_http" if cfg.get("url") else "stdio"
                result[name] = {
                    "name": name,
                    "enabled": True,
                    "auth_status": "active",
                    "transport": {"type": transport, **cfg},
                }
        return result

    def add(self, payload: dict[str, Any]) -> dict[str, Any]:
        name = str(payload.get("name") or "").strip()
        transport_type = str(payload.get("transport_type") or "stdio")
        url = str(payload.get("url") or "").strip()
        command: list[str] = payload.get("command") or []
        env_vars: dict[str, str] = payload.get("env_vars") or {}
        if not name:
            return {"ok": False, "message": "Name is required."}
        try:
            settings = self._read_settings()
            mcp_servers = settings.setdefault("mcpServers", {})
            if transport_type == "streamable_http":
                entry: dict[str, Any] = {"type": "http", "url": url}
            else:
                entry = {"command": command[0] if command else "npx", "args": command[1:] if command else []}
            if env_vars:
                entry["env"] = env_vars
            mcp_servers[name] = entry
            self._write_settings(settings)
            log_event("info", f"[claude-code] MCP server added: {name}")
            return {"ok": True, "name": name, "message": f"'{name}' added to Claude Code config."}
        except Exception as exc:
            log_event("error", f"[claude-code] MCP add failed: {name}", error=str(exc))
            return {"ok": False, "name": name, "message": str(exc)}

    def remove(self, name: str) -> dict[str, Any]:
        try:
            settings = self._read_settings()
            removed = settings.get("mcpServers", {}).pop(name, None)
            if removed is None:
                return {"ok": False, "name": name, "message": f"'{name}' not found in Claude Code config."}
            self._write_settings(settings)
            log_event("info", f"[claude-code] MCP server removed: {name}")
            return {"ok": True, "name": name, "message": f"Removed '{name}' from Claude Code config."}
        except Exception as exc:
            return {"ok": False, "name": name, "message": str(exc)}

    def login_instructions(self, name: str) -> dict[str, Any]:
        return {
            "ok": True, "name": name, "requires_terminal": False,
            "message": "Claude Code handles OAuth automatically when the MCP server is first used.",
        }


# ── adapter registry ──────────────────────────────────────────────────────────
_MCP_ADAPTERS: dict[str, McpClientAdapter] = {
    "codex": CodexMcpAdapter(),
    "claude-code": ClaudeCodeMcpAdapter(),
}

def get_mcp_adapter(client: str) -> McpClientAdapter:
    return _MCP_ADAPTERS.get(client, _MCP_ADAPTERS["codex"])


# ── public MCP functions (dispatch to adapter) ────────────────────────────────
def mcp_list(client: str = "codex") -> dict[str, Any]:
    return get_mcp_adapter(client).build_server_list()


def mcp_add(payload: dict[str, Any], client: str = "codex") -> dict[str, Any]:
    return get_mcp_adapter(client).add(payload)


def mcp_remove(name: str, client: str = "codex") -> dict[str, Any]:
    return get_mcp_adapter(client).remove(name)


def mcp_login_instructions(name: str, client: str = "codex") -> dict[str, Any]:
    return get_mcp_adapter(client).login_instructions(name)


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
            self.write_json({"status": "ok", "runner": "specter-host-runner", "version": HOST_RUNNER_VERSION})
            return
        if self.path == "/version":
            self.write_json({"version": HOST_RUNNER_VERSION})
            return
        if self.path == "/mode":
            self.write_json(runner_mode())
            return
        if self.path.startswith("/logs"):
            qs: dict[str, str] = {}
            if "?" in self.path:
                for part in self.path.split("?", 1)[1].split("&"):
                    if "=" in part:
                        k, v = part.split("=", 1)
                        qs[k] = v
            since = int(qs.get("since", "0") or "0")
            level = qs.get("level") or None
            limit = min(int(qs.get("limit", "200") or "200"), 500)
            self.write_json(get_logs(since=since, level=level, limit=limit))
            return
        if self.path == "/runtimes/codex/status":
            self.write_json(codex_status())
            return
        if self.path == "/runtimes/docker-sandbox/status":
            self.write_json(docker_sandbox_status())
            return
        if self.path == "/runtimes/direct-cli/status":
            self.write_json(direct_cli_status())
            return
        if self.path == "/runtimes/docker-sandbox/policy":
            self.write_json(docker_sandbox_policy_status())
            return
        if self.path == "/launchd/status":
            self.write_json(launchd_status())
            return
        if self.path.startswith("/mcp/list"):
            client = self._qs_param(self.path, "client", "codex")
            self.write_json(mcp_list(client))
            return
        if self.path.startswith("/mcp/login/"):
            rest = self.path[len("/mcp/login/"):]
            name, _, qs = rest.partition("?")
            client = self._qs_param("?" + qs, "client", "codex")
            self.write_json(mcp_login_instructions(name, client))
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
        if self.path == "/runtimes/direct-cli/run":
            self.write_json(run_direct_cli_task(self.read_json()))
            return
        if self.path == "/runtimes/docker-sandbox/run":
            self.write_json(run_sandbox_agent_task(self.read_json()))
            return
        if self.path == "/runtimes/docker-sandbox/daemon/start":
            self.write_json(sbx_daemon_start())
            return
        if self.path == "/runtimes/docker-sandbox/policy":
            self.write_json(set_docker_sandbox_policy(self.read_json()))
            return
        if self.path.startswith("/runtimes/codex/kill/"):
            token = self.path[len("/runtimes/codex/kill/"):]
            killed = _job_kill(token)
            self.write_json({"ok": killed, "token": token})
            return
        if self.path == "/launchd/install":
            self.write_json(launchd_install())
            return
        if self.path == "/launchd/uninstall":
            self.write_json(launchd_uninstall())
            return
        if self.path == "/launchd/restart":
            self.write_json(launchd_restart())
            return
        if self.path == "/repositories/discover":
            self.write_json(discover_repositories(self.read_json()))
            return
        if self.path.startswith("/mcp/add"):
            client = self._qs_param(self.path, "client", "codex")
            self.write_json(mcp_add(self.read_json(), client))
            return
        if self.path.startswith("/mcp/remove/"):
            rest = self.path[len("/mcp/remove/"):]
            name, _, qs = rest.partition("?")
            client = self._qs_param("?" + qs, "client", "codex")
            self.write_json(mcp_remove(name, client))
            return
        self.write_json({"error": "Not found"}, status=HTTPStatus.NOT_FOUND)

    def log_message(self, format: str, *args: Any) -> None:
        message = format % args
        # Suppress high-frequency polling endpoints from the event log
        if not any(p in message for p in ("/logs", "/health", "/version", "/launchd/status", "/host-runner/version")):
            log_event("debug", message, client=self.address_string())

    @staticmethod
    def _qs_param(path: str, key: str, default: str = "") -> str:
        """Extract a single query-string parameter from a path like /foo?a=1&b=2."""
        if "?" not in path:
            return default
        qs = path.split("?", 1)[1]
        for part in qs.split("&"):
            k, _, v = part.partition("=")
            if k == key:
                return v or default
        return default

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
    import sys as _sys
    if len(_sys.argv) > 1 and _sys.argv[1] == "--version":
        print(HOST_RUNNER_VERSION)
        raise SystemExit(0)
    if len(_sys.argv) > 1 and _sys.argv[1] == "--install-service":
        result = launchd_install()
        print(result["message"])
        raise SystemExit(0 if result["ok"] else 1)
    main()
