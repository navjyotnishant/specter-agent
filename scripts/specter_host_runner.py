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
import time
import urllib.error
import urllib.parse
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
# launchd hands this process PATH=/usr/bin:/bin:/usr/sbin:/sbin, so anything
# installed by Homebrew, npm, or pip is invisible to shutil.which(). These are the
# roots to search explicitly, and to prepend when spawning a child process.
CLI_INSTALL_ROOTS = [
    Path("/opt/homebrew/bin"),
    Path("/usr/local/bin"),
    Path.home() / ".local" / "bin",
    Path.home() / ".npm-global" / "bin",
    Path.home() / "bin",
]


def _augmented_path() -> str:
    """PATH with the usual install roots prepended, for spawned child processes."""
    existing = os.environ.get("PATH", "").split(os.pathsep)
    roots = [str(root) for root in CLI_INSTALL_ROOTS]
    return os.pathsep.join(roots + [p for p in existing if p and p not in roots])


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
        # model: optional model name, forwarded via each CLI's own model flag (empty = CLI default)
        "exec_args": lambda p, model="": ["codex", "exec", "--sandbox", "read-only", "--json", *(["-m", model] if model else []), p],
        "docs_url": "https://docs.docker.com/ai/sandboxes/agents/codex/",
    },
    "claude": {
        "key": "claude",
        "display_name": "Claude Code",
        "template": "docker/sandbox-templates:claude-code",
        "run_cmd": "claude",
        "auth_provider": "anthropic",
        "auth_flag": None,
        "exec_args": lambda p, model="": ["claude", "--dangerously-skip-permissions", *(["--model", model] if model else []), "-p", p],
        "docs_url": "https://docs.docker.com/ai/sandboxes/agents/claude-code/",
    },
    "cursor": {
        "key": "cursor",
        "display_name": "Cursor",
        "template": "docker/sandbox-templates:cursor",
        "run_cmd": "cursor",
        "auth_provider": None,  # OAuth proxy-managed; first run prompts browser login via sbx run cursor
        "auth_flag": None,
        "exec_args": lambda p, model="": ["cursor-agent", "--print", *(["--model", model] if model else []), p],
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


# Logs are served over /logs, so scrub anything token-shaped before it lands there.
# Belt-and-braces: nothing should log a token, but one careless f-string would
# otherwise publish it over HTTP.
_SECRET_PATTERNS = (
    re.compile(r"\b\d{6,12}:[A-Za-z0-9_-]{30,}\b"),   # telegram bot token
    re.compile(r"\bBearer\s+[A-Za-z0-9._~+/-]{16,}"),  # auth header
    re.compile(r"/bot\d{6,12}:[A-Za-z0-9_-]+"),        # token embedded in a URL
)


def _scrub(text: str) -> str:
    for pattern in _SECRET_PATTERNS:
        text = pattern.sub("[redacted]", text)
    return text


def log_event(level: str, message: str, **metadata: Any) -> None:
    global LOG_SEQ
    message = _scrub(message)
    with LOG_LOCK:
        LOG_SEQ += 1
        seq = LOG_SEQ
    entry = {
        "seq": seq,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "level": level,
        "message": message,
        "metadata": {
            k: (_scrub(v) if isinstance(v, str) else v)
            for k, v in metadata.items() if v is not None and v != ""
        },
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


def sbx_daemon_running() -> bool:
    """True when `sbx daemon status` reports a live daemon."""
    executable = best_sbx_candidate()[0]
    if not executable:
        return False
    try:
        result = subprocess.run(
            [executable["path"], "daemon", "status"],
            capture_output=True, text=True, timeout=10, check=False,
        )
    except Exception:
        return False
    return result.returncode == 0 and "running" in (result.stdout + result.stderr).lower()


def sbx_daemon_start() -> dict[str, Any]:
    """Start the sbx daemon, detached so it outlives this request.

    `sbx daemon start` runs in the FOREGROUND -- it does not fork. Waiting on it
    with subprocess.run() blocks until the timeout and then kills the daemon,
    which is why starting it from the app never stuck. Spawn it in its own
    session with Popen and poll `daemon status` for readiness instead.
    """
    best = best_sbx_candidate()[0]
    if not best:
        return {"ok": False, "message": "Docker Sandboxes CLI is not installed."}
    if sbx_daemon_running():
        return {"ok": True, "message": "sbx daemon is already running."}

    log_path = Path.home() / ".specter" / "sbx-daemon.log"
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        handle = open(log_path, "ab")
    except OSError:
        handle = subprocess.DEVNULL

    try:
        subprocess.Popen(
            [best["path"], "daemon", "start"],
            stdout=handle, stderr=handle, stdin=subprocess.DEVNULL,
            start_new_session=True,  # detach from the runner's process group
            env={**os.environ, "PATH": _augmented_path()},
        )
    except Exception as exc:
        return {"ok": False, "message": f"Could not launch sbx daemon: {exc}"}

    for _ in range(20):  # up to ~10s for the socket to come up
        time.sleep(0.5)
        if sbx_daemon_running():
            log_event("info", "sbx daemon started", log_path=str(log_path))
            return {"ok": True, "message": "sbx daemon started successfully."}

    return {
        "ok": False,
        "message": f"sbx daemon did not report ready within 10s. See {log_path}.",
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
    model = str(payload.get("model") or "").strip()

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
    exec_command = [SBX, "exec", sandbox_name, *agent["exec_args"](prompt, model)]

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

def _resolve_cli(*names: str) -> str | None:
    """Locate a CLI by name, tolerating launchd's minimal PATH.

    Under launchd the runner inherits PATH=/usr/bin:/bin:/usr/sbin:/sbin, so
    shutil.which() misses every user- and Homebrew-installed CLI and the agent
    gets reported as "not installed" while it is sitting in ~/.local/bin. Check
    the usual install roots explicitly as a fallback.
    """
    roots = CLI_INSTALL_ROOTS
    for name in names:
        found = shutil.which(name)
        if found:
            return found
        for root in roots:
            candidate = root / name
            if candidate.is_file() and os.access(candidate, os.X_OK):
                return str(candidate)
    return None


def _claude_path() -> str | None:
    return _resolve_cli("claude")

def _cursor_agent_path() -> str | None:
    return _resolve_cli("cursor-agent", "cursor")

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
        "cmd_fn": lambda exe, ws, p, model="": [exe, "exec", "--cd", ws, "--sandbox", "read-only", "--json", "--color", "never", *(["-m", model] if model else []), p],
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
        "cmd_fn": lambda exe, ws, p, model="": [exe, "--dangerously-skip-permissions", *(["--model", model] if model else []), "-p", p],
        "check_auth": _check_claude_auth,
        "auth_note": "Run `claude /login` in your terminal to authenticate.",
        "docs_url": "https://docs.anthropic.com/claude-code",
    },
    "cursor": {
        "key": "cursor",
        "display_name": "Cursor",
        "binary": "cursor-agent",
        "find_exe": _cursor_agent_path,
        "cmd_fn": lambda exe, ws, p, model="": [exe, "--trust", "--print", *(["--model", model] if model else []), p],
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
    model = str(payload.get("model") or "").strip()

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

    command = agent["cmd_fn"](exe, str(workspace), prompt, model)
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


AGENT_REPO_MAX_ITEMS = 200
AGENT_REPO_MAX_BODY = 20_000
# Monorepos nest deeply (packages/*/src/agents/...). 6 was too shallow and failed
# silently; the skip-list keeps the wider walk cheap.
AGENT_REPO_MAX_DEPTH = 12
AGENT_REPO_SKIP_DIRS = SCAN_IGNORE_DIRS | {
    "node_modules", "site", "dist", "build", "vendor", "target", "__pycache__",
    # Scaffolding and fixtures define placeholder names (<skill-name>), not real
    # skills -- importing them would create junk rows.
    "templates", "template", "examples", "example", "fixtures", "testdata", "tests", "test",
}
AGENT_REPO_VALID_CLASSES = {"review", "authoring", "workflow", "pm", "social"}
_AGENT_REPO_IGNORED_MD = {
    "README.MD", "CHANGELOG.MD", "LICENSE.MD", "CONTRIBUTING.MD", "CODE_OF_CONDUCT.MD",
    "SECURITY.MD", "HANDOFF.MD", "CLAUDE.MD", "AGENTS.MD", "GEMINI.MD",
}
CLONE_ALLOWED_HOSTS = {"github.com", "gitlab.com"}
CLONE_ROOT = Path.home() / ".specter" / "imports"
_SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+")
_REF_RE = re.compile(r"`([a-z0-9][a-z0-9-]{2,})`")

# Ordering is expressed in prose, in two shapes:
#   `blog-writer` → `blog-fact-checker` → `blog-reviewer`   (backticked, authoritative)
#   writer → fact-checker → reviewer → editor               (bare, needs resolving)
_CHAIN_SEP = r"(?:→|->|—>)"
_CHAIN_BACKTICKED_RE = re.compile(
    rf"`([a-z0-9][a-z0-9-]{{2,}})`(?:\s*{_CHAIN_SEP}\s*`([a-z0-9][a-z0-9-]{{2,}})`)+"
)
_CHAIN_ANY_RE = re.compile(
    rf"`?([a-z0-9][a-z0-9-]{{2,}})`?(?:\s*{_CHAIN_SEP}\s*`?([a-z0-9][a-z0-9-]{{2,}})`?)+"
)
_CHAIN_LINK_RE = re.compile(rf"\s*{_CHAIN_SEP}\s*")
# "spawn these in a single message (parallel)", "fans out", "runs in parallel"
_PARALLEL_RE = re.compile(
    r"in parallel|parallel\)|fans? out|concurrently|independent and runs",
    re.IGNORECASE,
)
# Parallel branches that reconverge: "then converge", "aggregates one verdict".
_FANIN_RE = re.compile(
    r"converge|aggregat\w+|combine[sd]? the (?:results|outputs)|then apply serially",
    re.IGNORECASE,
)

# A skill that blocks on a human decision before doing something outward-facing
# should import as a humanApproval gate rather than running unattended.
#
# Deliberately specific: generic cost-control boilerplate ("State it and get a yes
# before the first dispatch") appears in EVERY skill of this toolkit, so matching
# it would gate all of them and make the signal worthless.
_APPROVAL_PATTERNS: tuple[tuple[str, str], ...] = (
    (r"never auto-?(?:post|publish|commit|push|merge|creat)", "acts outward only after you confirm"),
    (r"on opt-in,? (?:it )?creates?|creates? it \*{0,2}on opt-in", "creates the item only on opt-in"),
    (r"only if (?:you|the user) opts? in|and (?:you|the user) opts? in", "proceeds only if you opt in"),
    (r"proposes the commit|propose the commit", "proposes a commit for you to approve"),
    (r"one (?:explicit )?opt-in|ONE opt-in|explicit opt-in before any", "needs one explicit approval before creating"),
    (r"human decides|the human decides", "a human decides the outcome"),
    (r"before (?:you )?publish|never publishes", "waits for approval before publishing"),
)
_APPROVAL_RES = tuple((re.compile(p, re.IGNORECASE), label) for p, label in _APPROVAL_PATTERNS)

# Agents that act on the finished artifact (publish, post, promote). They depend on
# everything upstream, so fanning them out from the supervisor would run them before
# the artifact exists -- e.g. a promo agent with no published URL to reference.
_TERMINAL_AGENT_RE = re.compile(
    r"(?:^|-)(poster|publish\w*|promo\w*|announce\w*|deploy\w*|notifier?)$|"
    r"^social-post$|^release-notes$",
    re.IGNORECASE,
)


def _is_terminal_agent(key: str, body: str) -> bool:
    """True when an agent should run after the main pipeline rather than beside it.

    Name is the primary signal; prose like "must clear before posting" or "needs a
    published URL" confirms the dependency where the name alone is ambiguous.
    """
    if _TERMINAL_AGENT_RE.search(key):
        return True
    near = re.search(
        rf"`{re.escape(key)}`[^.]{{0,200}}(?:published|after (?:the )?(?:post|publish)|"
        rf"before posting|needs a published)",
        body,
        re.IGNORECASE,
    )
    return bool(near)


def _detect_approval_gate(body: str, description: str) -> dict[str, Any]:
    """Decide whether a skill pauses for a human before acting.

    Returns {"required": bool, "reason": str, "signals": [...]}. The reason is
    shown in the picker and becomes the humanApproval node's prompt, so it has to
    read as a sentence rather than a regex name.
    """
    haystack = f"{description}\n{body}"
    signals = [label for pattern, label in _APPROVAL_RES if pattern.search(haystack)]
    if not signals:
        return {"required": False, "reason": "", "signals": []}
    return {
        "required": True,
        # Most specific signal first -- the tuple is ordered by how load-bearing it is.
        "reason": signals[0],
        "signals": signals,
    }


def _extract_pipeline(body: str, agent_keys: set[str]) -> tuple[list[list[str]], bool]:
    """Pull ordered agent chains out of a skill's prose.

    Returns (chains, mentions_parallel, mentions_fan_in). Each chain is an ordered
    list of agent keys meaning "a runs, then b, then c". Bare names are resolved
    against the known agents by suffix, so `writer → fact-checker` maps onto
    blog-writer and blog-fact-checker when this skill spawns them.
    """
    chains: list[list[str]] = []

    def resolve(token: str) -> str | None:
        if token in agent_keys:
            return token
        # Bare shorthand: "writer" for blog-writer. Only accept an unambiguous match.
        matches = [k for k in agent_keys if k.endswith(f"-{token}") or k == token]
        return matches[0] if len(matches) == 1 else None

    for match in _CHAIN_ANY_RE.finditer(body):
        tokens = [t for t in _CHAIN_LINK_RE.split(match.group(0)) if t]
        resolved = [resolve(t.strip().strip("`")) for t in tokens]
        # Keep the chain only if at least two links resolve to real agents; drop
        # unresolved middles rather than inventing an edge across them.
        keys = [k for k in resolved if k]
        if len(keys) >= 2 and len(keys) == len(resolved):
            deduped: list[str] = []
            for key in keys:
                if key not in deduped:
                    deduped.append(key)
            if len(deduped) >= 2 and deduped not in chains:
                chains.append(deduped)

    # Prefer longer chains; a 6-link chain supersedes the 4-link prefix of itself.
    chains.sort(key=len, reverse=True)
    kept: list[list[str]] = []
    for chain in chains:
        joined = ">".join(chain)
        if not any(joined in ">".join(other) for other in kept):
            kept.append(chain)

    return kept, bool(_PARALLEL_RE.search(body)), bool(_FANIN_RE.search(body))


def _split_frontmatter(text: str) -> tuple[dict[str, str], str]:
    """Split a `---` fenced YAML frontmatter block into flat scalars plus the body.

    Deliberately stdlib-only: the host runner is launchd-run and dependency-free, and
    every key these files use (name/description/class/subclass/version/color/author)
    is a flat scalar. Handles the one real edge case in the wild -- a double-quoted
    value that spans lines (agents/blog-writer.md embeds an <example> block with
    literal \\n escapes in its description).
    """
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, text
    try:
        end = next(i for i in range(1, len(lines)) if lines[i].strip() == "---")
    except StopIteration:
        return {}, text

    meta: dict[str, str] = {}
    i = 1
    while i < end:
        key, sep, value = lines[i].partition(":")
        i += 1
        key = key.strip()
        if not sep or not key or key.startswith("#"):
            continue
        value = value.strip()
        if value.startswith('"') and not (len(value) > 1 and value.endswith('"')):
            # Quoted value continues onto following lines until the closing quote.
            parts = [value]
            while i < end and not lines[i].rstrip().endswith('"'):
                parts.append(lines[i])
                i += 1
            if i < end:
                parts.append(lines[i])
                i += 1
            value = "\n".join(parts)
        if len(value) > 1 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        meta[key] = value.replace("\\n", "\n")

    return meta, "\n".join(lines[end + 1:]).strip()


def _first_sentence(text: str, limit: int = 160) -> str:
    flat = " ".join(text.split())
    cut = flat.split(". ")[0].strip()
    return (cut[: limit - 1] + "…") if len(cut) > limit else cut


def _discover_agent_files(root: Path) -> tuple[list[tuple[Path, str]], str]:
    """Find every skill/agent-shaped markdown file, wherever it lives in the repo.

    The portable signal is the file itself -- markdown with `name`+`description`
    frontmatter -- not a hardcoded directory. Layout only supplies a *hint* about
    whether a file is a skill or an agent; the file's own frontmatter wins. This is
    what lets a repo that is not nj-agents (a .claude/ plugin, an agents-only repo,
    a monorepo with skills nested under packages/*) import without special-casing.

    Returns ([(path, hint)], shape, limits) where hint is "skill" | "agent" | ""
    and limits records whether the scan was cut short (so the caller can say so
    rather than silently reporting an empty repo).
    """
    found: list[tuple[Path, str]] = []
    hint_dirs = {"skills": "skill", "agents": "agent", "subagents": "agent", "commands": "skill"}
    roots_seen: set[str] = set()
    budget = AGENT_REPO_MAX_ITEMS * 4
    limits = {"depth_hit": False, "budget_hit": False, "max_depth": AGENT_REPO_MAX_DEPTH}

    def hint_for(path: Path) -> str:
        # Nearest ancestor directory that names a known kind, e.g. .claude/agents/x.md
        # or skills/foo/SKILL.md. SKILL.md itself is an unambiguous marker.
        if path.name.upper() == "SKILL.md".upper():
            return "skill"
        for part in reversed(path.relative_to(root).parts[:-1]):
            if part.lower() in hint_dirs:
                return hint_dirs[part.lower()]
        return ""

    def walk(path: Path, depth: int) -> None:
        nonlocal budget
        if budget <= 0:
            limits["budget_hit"] = True
            return
        if depth > AGENT_REPO_MAX_DEPTH:
            limits["depth_hit"] = True
            return
        try:
            children = sorted(path.iterdir(), key=lambda c: c.name.lower())
        except (PermissionError, OSError):
            return
        for child in children:
            if budget <= 0:
                limits["budget_hit"] = True
                return
            name = child.name
            if child.is_dir():
                if name in AGENT_REPO_SKIP_DIRS or (name.startswith(".") and name != ".claude"):
                    continue
                walk(child, depth + 1)
            elif (
                name.lower().endswith(".md")
                and name.upper() not in _AGENT_REPO_IGNORED_MD
                and not name.upper().startswith("CONVENTIONS")
            ):
                budget -= 1
                hint = hint_for(child)
                # Cheap pre-filter: only files with a frontmatter fence can qualify.
                try:
                    with child.open("r", encoding="utf-8", errors="replace") as fh:
                        if fh.readline().strip() != "---":
                            continue
                except OSError:
                    continue
                found.append((child, hint))
                rel = child.relative_to(root).parts
                roots_seen.add(rel[0] if len(rel) > 1 else "")

    walk(root, 0)

    if not found:
        shape = "unknown"
    elif (root / ".claude").is_dir() and any(".claude" in f.parts for f, _ in found):
        shape = "claude-plugin"
    elif (root / "skills").is_dir() and (root / "agents").is_dir():
        shape = "skills-and-agents"
    else:
        shape = "markdown-agents"
    return found, shape, limits


_CODE_AGENT_EXTS = {".py": "Python", ".ts": "TypeScript", ".js": "JavaScript", ".go": "Go", ".rb": "Ruby"}


def _describe_unsupported_layout(root: Path) -> str:
    """Explain what the repo *does* contain when no markdown definitions are found.

    The common near-miss is a repo that defines agents in code (a `make_agent()`
    factory, a CrewAI/LangGraph graph) rather than in markdown. Saying so turns a
    dead end into a diagnosis, and distinguishes it from a wrong path.
    """
    hints: list[str] = []

    # An agents/ or skills/ directory holding source files rather than markdown.
    for dirname in ("agents", "skills", "subagents"):
        for found in list(root.rglob(dirname))[:20]:
            if not found.is_dir() or any(p in AGENT_REPO_SKIP_DIRS for p in found.parts):
                continue
            langs: dict[str, int] = {}
            for child in list(found.iterdir())[:100]:
                lang = _CODE_AGENT_EXTS.get(child.suffix.lower())
                if child.is_file() and lang and child.name != "__init__.py":
                    langs[lang] = langs.get(lang, 0) + 1
            if langs:
                lang, count = max(langs.items(), key=lambda kv: kv[1])
                rel = found.relative_to(root)
                hints.append(
                    f"Found {count} {lang} file(s) under `{rel}/` — this repo appears to define "
                    f"agents in code, which this importer does not parse yet."
                )
                break
        if hints:
            break

    if not hints:
        md = [p for p in list(root.rglob("*.md"))[:200]
              if not any(part in AGENT_REPO_SKIP_DIRS or part == ".git" for part in p.parts)]
        if md:
            names = ", ".join(sorted(p.name for p in md[:4]))
            hints.append(
                f"The repo has {len(md)} markdown file(s) ({names}"
                f"{'…' if len(md) > 4 else ''}) but none carry skill/agent frontmatter."
            )
        else:
            hints.append("No markdown files found at all — check that the path points at the right repository.")

    return " ".join(hints)


def parse_agent_repository(payload: dict[str, Any]) -> dict[str, Any]:
    """Parse an agentic-orchestrator repo into a neutral skills/agents/refs model.

    Also grades the repo for compatibility in the same pass (every file is already
    being read), so the UI can show a verdict before the user picks anything.
    """
    repo_value = str(payload.get("repo_path") or "").strip()
    if not repo_value:
        return {"ok": False, "message": "Repository path is required.", "shape": "unknown"}

    root = Path(repo_value).expanduser().resolve()
    if not root.is_dir():
        return {"ok": False, "message": "Repository path does not exist or is not a directory.", "shape": "unknown"}

    discovered, shape, scan_limits = _discover_agent_files(root)
    checks: list[dict[str, Any]] = []
    warnings: list[str] = []

    def check(check_id: str, level: str, ok: bool, message: str, files: list[str] | None = None) -> None:
        checks.append({"id": check_id, "level": level, "ok": ok, "message": message, "files": files or []})

    if shape == "unknown":
        # "Nothing found" is a dead end; say what IS there so the user can tell a
        # wrong path from an unsupported layout.
        hint = _describe_unsupported_layout(root)
        if scan_limits.get("depth_hit"):
            hint += (
                f" The scan also stopped at {scan_limits['max_depth']} directory levels — if your"
                " definitions live deeper, point the import at that subdirectory instead."
            )
        check(
            "shape-detected", "error", False,
            "No skill- or agent-shaped markdown found (a .md file with `name` and `description` frontmatter). "
            "Looked anywhere in the repo, not just skills/ or .claude/."
            + (f" {hint}" if hint else ""),
        )
        return {
            "ok": True, "shape": "unknown",
            "repo": {"name": root.name, "path": str(root), "remote_url": None},
            "skills": [], "agents": [], "warnings": [],
            "compat": {
                "score": 0, "verdict": "incompatible", "shape": "unknown", "shape_confidence": "none",
                "counts": {"skills": 0, "agents": 0, "refs": 0, "orphan_agents": 0, "dangling_refs": 0, "leaf_skills": 0},
                "checks": checks,
            },
        }

    check("shape-detected", "info", True, f"Detected a {shape} layout.")

    bad_frontmatter: list[str] = []
    name_mismatch: list[str] = []
    missing_description: list[str] = []
    bad_class: list[str] = []
    oversize: list[str] = []

    def read_entry(path: Path, key: str, rel: str) -> tuple[dict[str, Any], dict[str, str]]:
        try:
            raw = path.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            bad_frontmatter.append(rel)
            return {"key": key, "name": key, "description": "", "body": "", "source_path": rel,
                    "error": f"unreadable: {exc}"}, {}

        meta, body = _split_frontmatter(raw)
        entry: dict[str, Any] = {
            "key": key,
            "name": meta.get("name") or key,
            "description": meta.get("description", ""),
            "version": meta.get("version", ""),
            "author": meta.get("author", ""),
            "source_path": rel,
            "body": body[:AGENT_REPO_MAX_BODY],
        }
        if not meta:
            bad_frontmatter.append(rel)
            entry["error"] = "no parseable frontmatter block"
        elif meta.get("name") and meta["name"] != key:
            name_mismatch.append(rel)
            entry["error"] = f"frontmatter name '{meta['name']}' does not match path '{key}'"
        elif not entry["description"].strip():
            missing_description.append(rel)
            entry["error"] = "description is empty"
        if len(body) > AGENT_REPO_MAX_BODY:
            oversize.append(rel)
        return entry, meta

    skills: list[dict[str, Any]] = []
    agents: list[dict[str, Any]] = []
    skipped_unshaped = 0

    for path, hint in discovered:
        rel = str(path.relative_to(root))
        key = path.parent.name if path.name.upper() == "SKILL.MD" else path.stem
        entry, meta = read_entry(path, key, rel)

        # A file qualifies only if it declares both a name and a description. That is
        # the portable contract across nj-agents, .claude plugins, and anything else
        # following the Agent Skills convention -- README/docs noise fails it.
        if not meta.get("name") or not meta.get("description", "").strip():
            if hint not in ("skill", "agent"):
                skipped_unshaped += 1
                for bucket in (bad_frontmatter, name_mismatch, missing_description):
                    if rel in bucket:
                        bucket.remove(rel)
                continue

        # The file's own frontmatter decides; the directory is only a fallback hint.
        declared = (meta.get("kind") or meta.get("type") or "").strip().lower()
        if declared in ("skill", "command"):
            kind = "skill"
        elif declared in ("agent", "subagent"):
            kind = "agent"
        elif meta.get("class") or meta.get("subclass") or path.name.upper() == "SKILL.MD":
            kind = "skill"
        elif meta.get("tools") or meta.get("model") or meta.get("color"):
            kind = "agent"
        else:
            kind = hint or "agent"

        if kind == "skill":
            if len(skills) >= AGENT_REPO_MAX_ITEMS:
                continue
            meta_class = meta.get("class", "")
            meta_sub = meta.get("subclass", "")
            entry["class"] = meta_class
            entry["subclass"] = meta_sub
            if meta_class and meta_class not in AGENT_REPO_VALID_CLASSES:
                bad_class.append(rel)
            elif meta_class == "review" and not meta_sub:
                bad_class.append(rel)
            entry["spawns"] = []
            skills.append(entry)
        else:
            if len(agents) >= AGENT_REPO_MAX_ITEMS:
                continue
            entry["color"] = meta.get("color", "")
            entry["spawned_by"] = []
            agents.append(entry)

    # De-duplicate keys within each kind (a monorepo can define the same slug twice).
    def dedupe(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        seen: set[str] = set()
        out: list[dict[str, Any]] = []
        for item in items:
            if item["key"] in seen:
                warnings.append(f"Duplicate key '{item['key']}' at {item['source_path']} was skipped.")
                continue
            seen.add(item["key"])
            out.append(item)
        return out

    skills = dedupe(skills)
    agents = dedupe(agents)

    skill_keys = {s["key"]: s for s in skills}
    agent_keys = {a["key"]: a for a in agents}

    ref_count = 0
    dangling = 0
    for skill in skills:
        # Order of first mention, not alphabetical -- a skill's prose introduces its
        # agents in the order they run, which is the closest thing to authoring intent.
        seen_refs: list[str] = []
        for ref in _REF_RE.findall(skill["body"]):
            if ref not in seen_refs:
                seen_refs.append(ref)
        for ref in seen_refs:
            # A skill and an agent may legitimately share a name (dead-code-finder,
            # deps-upgrade, test-gap-finder), so a same-name reference is a real
            # skill->agent edge, not a self-reference. Only the skill->skill case
            # is genuinely self-referential and gets dropped.
            if ref in agent_keys:
                skill["spawns"].append({"key": ref, "kind": "agent"})
                agent_keys[ref]["spawned_by"].append(skill["key"])
                ref_count += 1
            if ref in skill_keys and ref != skill["key"]:
                skill["spawns"].append({"key": ref, "kind": "skill"})
                ref_count += 1

    # Second pass: now that every skill knows which agents it spawns, read the
    # execution order out of its prose.
    chain_count = 0
    for skill in skills:
        skill["approval"] = _detect_approval_gate(skill["body"], skill.get("description", ""))
        spawned = {ref["key"] for ref in skill["spawns"] if ref["kind"] == "agent"}
        if not spawned:
            skill["pipeline"] = {"chains": [], "parallel": False, "fan_in": False, "terminal": [], "sequential_keys": []}
            continue
        chains, parallel, fan_in = _extract_pipeline(skill["body"], spawned)
        # Only keep links between agents this skill actually spawns.
        chains = [[k for k in chain if k in spawned] for chain in chains]
        chains = [c for c in chains if len(c) >= 2]
        sequential = [k for chain in chains for k in chain]
        skill["pipeline"] = {
            "chains": chains,
            "parallel": parallel,
            "fan_in": fan_in,
            # Ordered: these run last, after everything else has produced the artifact.
            # Ordered, and never an agent already placed by a chain -- the chain is
            # the more specific signal.
            "terminal": [
                k for k in sorted(spawned)
                if k not in {x for chain in chains for x in chain}
                and _is_terminal_agent(k, skill["body"])
            ],
            # Agents named in a chain run in order; the rest fan out from the supervisor.
            "sequential_keys": list(dict.fromkeys(sequential)),
        }
        chain_count += len(chains)

    orphans = [a["key"] for a in agents if not a["spawned_by"]]
    leaf_skills = [s["key"] for s in skills if not s["spawns"]]

    check("frontmatter-parses", "error", not bad_frontmatter,
          "Every skill/agent file has a parseable frontmatter block."
          if not bad_frontmatter else f"{len(bad_frontmatter)} file(s) have no parseable frontmatter.", bad_frontmatter)
    check("name-matches-path", "error", not name_mismatch,
          "Frontmatter names match their file/directory names."
          if not name_mismatch else f"{len(name_mismatch)} file(s) declare a name that does not match their path.", name_mismatch)
    check("description-present", "error", not missing_description,
          "Every skill/agent has a description."
          if not missing_description else f"{len(missing_description)} file(s) have an empty description.", missing_description)
    check("dangling-ref", "warn", dangling == 0, "All referenced skills/agents resolve to a file.")
    check("orphan-agent", "warn", not orphans,
          "Every agent is spawned by at least one skill."
          if not orphans else f"{len(orphans)} agent(s) are not spawned by any skill: {', '.join(orphans[:8])}.")
    check("class-valid", "warn", not bad_class,
          "Skill classes are valid."
          if not bad_class else f"{len(bad_class)} skill(s) have a missing/invalid class or subclass.", bad_class)
    unversioned = [s["source_path"] for s in skills if not _SEMVER_RE.match(s.get("version", ""))]
    check("version-semver", "info", not unversioned,
          "All skills carry a semver version."
          if not unversioned else f"{len(unversioned)} skill(s) have a missing or non-semver version.", unversioned)
    check("body-size", "info", not oversize,
          "All bodies fit within the import size cap."
          if not oversize else f"{len(oversize)} file(s) were truncated at {AGENT_REPO_MAX_BODY} characters.", oversize)
    check("scan-complete", "warn", not (scan_limits.get("depth_hit") or scan_limits.get("budget_hit")),
          "The whole repository was scanned."
          if not (scan_limits.get("depth_hit") or scan_limits.get("budget_hit"))
          else ("Scan stopped early — "
                + ("some directories were deeper than "
                   f"{scan_limits['max_depth']} levels. " if scan_limits.get("depth_hit") else "")
                + ("the file-scan budget was reached. " if scan_limits.get("budget_hit") else "")
                + "Import the specific subdirectory to be sure nothing was missed."))
    conventions = sorted(p.name for p in root.glob("CONVENTIONS*.md"))
    check("conventions-present", "info", bool(conventions),
          f"Found shared conventions: {', '.join(conventions)}." if conventions else "No root CONVENTIONS*.md found.")

    # A per-file error excludes that file, not the whole import; only a repo-level
    # failure (nothing importable at all) makes the repo incompatible.
    importable = [e for e in skills + agents if not e.get("error")]
    excluded = [e for e in skills + agents if e.get("error")]
    errors = [c for c in checks if c["level"] == "error" and not c["ok"]]
    warns = [c for c in checks if c["level"] == "warn" and not c["ok"]]

    if not importable:
        verdict = "incompatible"
        if skills or agents:
            check("importable-entries", "error", False,
                  "Every skill/agent file failed validation - nothing can be imported.")
            errors = [c for c in checks if c["level"] == "error" and not c["ok"]]
    elif errors or warns:
        verdict = "partial"
    else:
        verdict = "compatible"
    score = max(0, 100 - 25 * len(errors) - 8 * len(warns))

    if excluded:
        warnings.append(f"{len(excluded)} file(s) were excluded from the import because they failed validation.")
    if skipped_unshaped:
        warnings.append(f"{skipped_unshaped} markdown file(s) were ignored (no name/description frontmatter).")
    if not skills and not agents:
        warnings.append("No skill or agent definitions were found in this repository.")

    remote = None
    try:
        result = subprocess.run(
            ["git", "-C", str(root), "remote", "get-url", "origin"],
            capture_output=True, text=True, timeout=3, check=False,
        )
        remote = result.stdout.strip() or None
    except Exception:
        remote = None

    log_event("info", "Parsed agent repository", repo_path=str(root), shape=shape,
              skills=len(skills), agents=len(agents), verdict=verdict)

    return {
        "ok": True,
        "shape": shape,
        "repo": {"name": root.name, "path": str(root), "remote_url": remote},
        "skills": skills,
        "agents": agents,
        "warnings": warnings,
        "compat": {
            "score": score,
            "verdict": verdict,
            "shape": shape,
            "shape_confidence": "high" if skills and agents else "low",
            "counts": {
                "skills": len(skills), "agents": len(agents), "refs": ref_count,
                "orphan_agents": len(orphans), "dangling_refs": dangling, "leaf_skills": len(leaf_skills),
                "importable": len(importable), "excluded": len(excluded),
            },
            "checks": checks,
        },
    }


MODEL_CACHE_TTL = 3600.0  # seconds; refresh button bypasses this
_model_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_model_cache_lock = threading.Lock()

# Grouping is presentation only -- the slug is matched case-insensitively against
# these prefixes so a 193-model list stays navigable. Order matters: first hit wins.
_MODEL_FAMILIES = (
    ("claude", "Claude"), ("opus", "Claude"), ("sonnet", "Claude"), ("haiku", "Claude"),
    ("fable", "Claude"), ("gpt", "GPT"), ("o1", "GPT"), ("o3", "GPT"), ("o4", "GPT"),
    ("codex", "GPT"), ("gemini", "Gemini"), ("grok", "Grok"), ("composer", "Composer"),
    ("deepseek", "DeepSeek"), ("kimi", "Kimi"), ("qwen", "Qwen"), ("llama", "Llama"),
)


def _model_family(slug: str) -> str:
    lowered = slug.lower()
    for needle, label in _MODEL_FAMILIES:
        if needle in lowered:
            return label
    return "Other"


def _models_from_ant() -> tuple[list[dict[str, Any]], str]:
    """Claude models via the Anthropic API. `ant` refreshes its own OAuth token."""
    exe = _resolve_cli("ant")
    if not exe:
        return [], "ant CLI not found on PATH"
    result = subprocess.run(
        [exe, "models", "list", "--transform", "{id,display_name}", "--format", "jsonl"],
        capture_output=True, text=True, timeout=45, check=False,
        env={**os.environ, "PATH": _augmented_path()},
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip().splitlines()
        return [], f"ant models list failed: {detail[-1] if detail else 'unknown error'}"

    models: list[dict[str, Any]] = []
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        slug = row.get("id")
        if slug:
            models.append({"slug": slug, "display_name": row.get("display_name") or slug})
    return models, ""


def _models_from_cursor() -> tuple[list[dict[str, Any]], str]:
    """Cursor prints `slug - Display Name`, one per line, after a header."""
    exe = _resolve_cli("cursor-agent", "cursor")
    if not exe:
        return [], "cursor-agent not found on PATH"
    result = subprocess.run(
        [exe, "models"], capture_output=True, text=True, timeout=45, check=False,
        env={**os.environ, "PATH": _augmented_path()},
    )
    if result.returncode != 0:
        return [], "cursor-agent models failed"

    models = []
    for line in result.stdout.splitlines():
        slug, sep, name = line.strip().partition(" - ")
        if sep and slug and " " not in slug:
            models.append({"slug": slug, "display_name": name.strip() or slug})
    return models, ""


def _models_from_codex() -> tuple[list[dict[str, Any]], str]:
    """Codex has no list command (openai/codex#8871, closed as not planned), but it
    caches its own catalog on disk -- richer than a hardcoded list, and it carries
    the per-model reasoning levels."""
    path = Path.home() / ".codex" / "models_cache.json"
    if not path.is_file():
        return [], "no codex model cache found (~/.codex/models_cache.json)"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return [], f"could not read codex model cache: {exc}"

    models = []
    for entry in data.get("models", []):
        slug = entry.get("slug")
        if not slug:
            continue
        models.append({
            "slug": slug,
            "display_name": entry.get("display_name") or slug,
            "description": entry.get("description", ""),
            "efforts": [e.get("effort") for e in entry.get("supported_reasoning_levels", []) if e.get("effort")],
            "default_effort": entry.get("default_reasoning_level", ""),
        })
    return models, ""


_MODEL_SOURCES = {
    "claude": ("ant models list", _models_from_ant),
    "cursor": ("cursor-agent models", _models_from_cursor),
    "codex": ("~/.codex/models_cache.json", _models_from_codex),
}


def list_agent_models(payload: dict[str, Any]) -> dict[str, Any]:
    """Discover the models each installed CLI actually supports.

    Every list is discovered at runtime rather than hardcoded, so it can't drift
    from what the CLI accepts. Results are cached because `cursor-agent models`
    and `ant models list` both take seconds; `refresh: true` bypasses the cache.
    """
    refresh = bool(payload.get("refresh"))
    requested = payload.get("agents") or list(_MODEL_SOURCES)
    now = time.monotonic()
    agents: dict[str, Any] = {}

    for agent in requested:
        source = _MODEL_SOURCES.get(agent)
        if not source:
            continue
        label, fetch = source

        with _model_cache_lock:
            cached = _model_cache.get(agent)
        if cached and not refresh and (now - cached[0]) < MODEL_CACHE_TTL:
            agents[agent] = {**cached[1], "cached": True}
            continue

        try:
            models, error = fetch()
        except subprocess.TimeoutExpired:
            models, error = [], f"{label} timed out"
        except Exception as exc:
            models, error = [], f"{label} failed: {exc}"

        for model in models:
            model["family"] = _model_family(model["slug"])

        entry = {
            "agent": agent,
            "source": label,
            "models": models,
            "count": len(models),
            "error": error,
            "families": sorted({m["family"] for m in models}),
        }
        if models:  # never cache a failure -- retry on the next call
            with _model_cache_lock:
                _model_cache[agent] = (now, entry)
        agents[agent] = {**entry, "cached": False}

    log_event("info", "Listed agent models",
              agents={k: v["count"] for k, v in agents.items()}, refresh=refresh)
    return {"ok": True, "agents": agents, "ttl_seconds": MODEL_CACHE_TTL}


def clone_agent_repository(payload: dict[str, Any]) -> dict[str, Any]:
    """Shallow-clone an allowlisted https git repo into ~/.specter/imports/.

    The destination is always derived from the URL and sanitized -- never taken from
    the caller -- so a hostile payload cannot choose where code lands on disk.
    """
    url = str(payload.get("repo_url") or "").strip()
    if not url:
        return {"ok": False, "message": "Repository URL is required."}

    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https":
        return {"ok": False, "message": "Only https:// git URLs are supported."}
    host = (parsed.hostname or "").lower()
    if host not in CLONE_ALLOWED_HOSTS:
        return {"ok": False, "message": f"Host '{host or 'unknown'}' is not allowed. Allowed: {', '.join(sorted(CLONE_ALLOWED_HOSTS))}."}
    if parsed.username or parsed.password:
        return {"ok": False, "message": "Credentials in the URL are not supported."}

    segments = [seg for seg in parsed.path.split("/") if seg not in ("", ".", "..")]
    if len(segments) < 2:
        return {"ok": False, "message": "URL must be of the form https://host/owner/repo."}
    owner, repo = segments[0], segments[1]
    if repo.endswith(".git"):
        repo = repo[:-4]

    # A GitHub/GitLab "browse" URL carries the subdirectory the user was looking at:
    #   https://host/owner/repo/tree/<ref>/<sub/path>
    # Clone the whole repo (git can't clone a subdir), but return the subpath so the
    # caller can scope the parse to it -- monorepos often keep agents under one package.
    subpath = ""
    if len(segments) > 3 and segments[2] in ("tree", "blob", "-"):
        tail = segments[4:] if segments[2] == "-" and len(segments) > 4 else segments[4:]
        subpath = "/".join(seg for seg in tail if seg not in ("", ".", ".."))
    slug = re.sub(r"[^a-z0-9._-]", "-", f"{owner}-{repo}".lower()).strip("-.")
    if not slug:
        return {"ok": False, "message": "Could not derive a safe directory name from that URL."}

    CLONE_ROOT.mkdir(parents=True, exist_ok=True)
    dest = (CLONE_ROOT / slug).resolve()
    if dest.parent != CLONE_ROOT.resolve():
        return {"ok": False, "message": "Refusing to clone outside the imports directory."}

    clean_url = urllib.parse.urlunsplit(("https", host, "/".join(segments[:2]), "", ""))
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": "true"}

    if (dest / ".git").is_dir():
        cmds = [
            ["git", "-C", str(dest), "fetch", "--depth", "1", "origin", "HEAD"],
            ["git", "-C", str(dest), "reset", "--hard", "FETCH_HEAD"],
        ]
        action = "updated"
    else:
        if dest.exists():
            shutil.rmtree(dest, ignore_errors=True)
        cmds = [["git", "clone", "--depth", "1", "--no-tags", "--recurse-submodules=no", clean_url, str(dest)]]
        action = "cloned"

    for cmd in cmds:
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=120, check=False, env=env)
        except subprocess.TimeoutExpired:
            return {"ok": False, "message": "git timed out after 120s."}
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "").strip().splitlines()
            return {"ok": False, "message": f"git failed: {detail[-1] if detail else 'unknown error'}"}

    # Point the caller at the subdirectory when the URL named one and it exists.
    scoped = dest
    if subpath:
        candidate = (dest / subpath).resolve()
        # Never let a crafted URL walk outside the cloned repo.
        if candidate.is_dir() and candidate.is_relative_to(dest):
            scoped = candidate
        else:
            subpath = ""

    log_event("info", f"Repository {action}", repo_url=clean_url, path=str(scoped))
    return {
        "ok": True, "path": str(scoped), "repo_root": str(dest), "subpath": subpath,
        "name": repo, "repo_url": clean_url, "action": action,
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
        if self.path == "/telegram/config":
            self.write_json(telegram_config_status())
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
        if self.path == "/telegram/config":
            self.write_json(save_telegram_config(self.read_json()))
            return
        if self.path == "/telegram/discover-chats":
            self.write_json(telegram_discover_chats(self.read_json()))
            return
        if self.path == "/models":
            self.write_json(list_agent_models(self.read_json()))
            return
        if self.path == "/repositories/parse":
            self.write_json(parse_agent_repository(self.read_json()))
            return
        if self.path == "/repositories/clone":
            self.write_json(clone_agent_repository(self.read_json()))
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

    # The sbx daemon has no service of its own, so it neither survives a reboot nor
    # recovers from a crash. This runner is already launchd-managed, so it adopts
    # the daemon -- starting and supervising it here avoids a second launchd job.
    threading.Thread(target=_ensure_sbx_daemon, daemon=True).start()

    # Telegram trigger: no-op unless ~/.specter/telegram.json exists.
    threading.Thread(target=_telegram_poll, daemon=True).start()

    server.serve_forever()


SBX_SUPERVISE_INTERVAL = 30.0     # seconds between health checks
SBX_SUPERVISE_BACKOFF_MAX = 8     # consecutive failures before backing off to ~5min


TELEGRAM_CONFIG = Path.home() / ".specter" / "telegram.json"
TELEGRAM_API = "https://api.telegram.org"


def _telegram_config() -> dict[str, Any]:
    """Read ~/.specter/telegram.json. Absent or malformed = feature off.

    Shape: {"bot_token": "...", "allowed_chat_ids": [123], "backend_url": "...",
            "api_token": "..."}

    No workspace here: each workflow carries its own, so a trigger can never run
    one workflow against another's repository.

    Which workflow runs is decided by the graphs themselves: any workflow with a
    trigger node whose source is "telegram" is eligible. workflow_id in the config
    is an optional override for pinning a single one.
    """
    try:
        cfg = json.loads(TELEGRAM_CONFIG.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return cfg if cfg.get("bot_token") and cfg.get("allowed_chat_ids") else {}


def telegram_config_status(_payload: dict[str, Any] | None = None) -> dict[str, Any]:
    """Config state for the UI. Never returns the bot token."""
    cfg = {}
    try:
        cfg = json.loads(TELEGRAM_CONFIG.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        pass
    token = str(cfg.get("bot_token") or "")
    return {
        "ok": True,
        "configured": bool(token and cfg.get("allowed_chat_ids")),
        "bot_token_set": bool(token),
        "bot_token_hint": f"…{token[-4:]}" if len(token) > 4 else "",
        "allowed_chat_ids": cfg.get("allowed_chat_ids") or [],
        "backend_url": cfg.get("backend_url", ""),
        "api_token_set": bool(cfg.get("api_token")),
        "path": str(TELEGRAM_CONFIG),
    }


def save_telegram_config(payload: dict[str, Any]) -> dict[str, Any]:
    """Write ~/.specter/telegram.json (0600). Blank secrets keep existing values."""
    current: dict[str, Any] = {}
    try:
        current = json.loads(TELEGRAM_CONFIG.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        pass

    chat_ids = []
    for raw in payload.get("allowed_chat_ids") or []:
        try:
            chat_ids.append(int(str(raw).strip()))
        except (TypeError, ValueError):
            return {"ok": False, "message": f"Chat id '{raw}' is not a number."}

    merged = {
        # Secrets: an empty field means "unchanged", so the UI never has to echo them back.
        "bot_token": str(payload.get("bot_token") or "").strip() or current.get("bot_token", ""),
        "api_token": str(payload.get("api_token") or "").strip() or current.get("api_token", ""),
        "allowed_chat_ids": chat_ids,
        "backend_url": str(payload.get("backend_url") or "").strip() or "http://127.0.0.1:8000",
    }
    if not merged["bot_token"]:
        return {"ok": False, "message": "A bot token is required."}
    if not chat_ids:
        return {"ok": False, "message": "At least one allowed chat id is required."}

    try:
        TELEGRAM_CONFIG.parent.mkdir(parents=True, exist_ok=True)
        # Create 0600 up front: write-then-chmod leaves a window where the token
        # is world-readable at the default umask.
        fd = os.open(TELEGRAM_CONFIG, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(merged, fh, indent=2)
        TELEGRAM_CONFIG.chmod(0o600)  # tighten if the file already existed
    except OSError as exc:
        return {"ok": False, "message": f"Could not write config: {exc}"}

    log_event("info", "Telegram config saved", chat_ids=len(chat_ids))
    return {**telegram_config_status(), "message": "Saved. The poller picks it up within a minute."}


def telegram_discover_chats(payload: dict[str, Any]) -> dict[str, Any]:
    """List chats that have messaged the bot, so the user never has to curl a
    token-bearing URL by hand. Uses the saved token when the field is left blank."""
    token = str(payload.get("bot_token") or "").strip()
    if not token:
        try:
            token = json.loads(TELEGRAM_CONFIG.read_text(encoding="utf-8")).get("bot_token", "")
        except (OSError, json.JSONDecodeError):
            token = ""
    if not token:
        return {"ok": False, "message": "Enter a bot token first."}

    try:
        resp = _telegram_call(token, "getUpdates", {"timeout": 0}, timeout=15)
    except urllib.error.HTTPError as exc:
        if exc.code == 401:
            return {"ok": False, "message": "Telegram rejected that token."}
        return {"ok": False, "message": f"Telegram returned {exc.code}."}
    except Exception:
        return {"ok": False, "message": "Could not reach Telegram."}

    chats: dict[int, str] = {}
    for update in resp.get("result", []):
        chat = ((update.get("message") or {}).get("chat")) or {}
        if chat.get("id") is None:
            continue
        name = chat.get("username") or " ".join(
            filter(None, [chat.get("first_name"), chat.get("last_name")])
        ) or chat.get("title") or str(chat["id"])
        chats[int(chat["id"])] = str(name)

    return {
        "ok": True,
        "chats": [{"id": cid, "name": name} for cid, name in chats.items()],
        "message": "" if chats else "No messages yet — send your bot a message, then retry.",
    }


def _telegram_call(token: str, method: str, payload: dict | None = None, timeout: float = 40) -> dict:
    url = f"{TELEGRAM_API}/bot{token}/{method}"
    data = json.dumps(payload or {}).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def _telegram_targets(cfg: dict) -> list[dict]:
    """Workflows with a telegram trigger node: [{id, name, field}].

    Config `workflow_id` pins one workflow and skips discovery.
    """
    if cfg.get("workflow_id"):
        return [{"id": cfg["workflow_id"], "name": "configured", "field": cfg.get("field", "topic")}]
    req = urllib.request.Request(
        f"{cfg['backend_url'].rstrip('/')}/api/workflows",
        headers={"Authorization": f"Bearer {cfg['api_token']}"},
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        workflows = json.loads(resp.read().decode())

    targets = []
    for wf in workflows:
        if wf.get("is_template"):
            continue
        for node in (wf.get("graph") or {}).get("nodes") or []:
            data = node.get("data") or {}
            if node.get("type") == "trigger" and str(data.get("source")) == "telegram":
                targets.append({"id": wf["id"], "name": wf["name"],
                                "field": str(data.get("fieldName") or "topic")})
                break
    return targets


def _telegram_start_run(cfg: dict, target: dict, text: str) -> tuple[str, str]:
    """Kick off a workflow run via the backend API. Returns a status line."""
    body = json.dumps({
        "workflow_id": target["id"],
        "run_input": {target["field"]: text},
        "trigger_type": "telegram",
    }).encode()
    req = urllib.request.Request(
        f"{cfg['backend_url'].rstrip('/')}/api/workflow-runs",
        data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {cfg['api_token']}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            run = json.loads(resp.read().decode())
        return f"Started {target['name']} — run {run['run_id'][:8]}", run["run_id"]
    except urllib.error.HTTPError as exc:
        return f"Could not start run: {exc.code} {exc.read()[:120].decode(errors='replace')}", ""
    except Exception as exc:
        return f"Could not start run: {exc}", ""


def _md_to_telegram_html(text: str) -> str:
    """Render agent markdown as Telegram HTML.

    Telegram sends plain text by default, so `##` and `**` show up literally.
    HTML rather than MarkdownV2: MarkdownV2 needs ~18 characters escaped and a
    single miss 400s the whole message.
    """
    out = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    lines: list[str] = []
    for line in out.split("\n"):
        heading = re.match(r"^#{1,6}\s+(.*)$", line.strip())
        if heading:
            lines.append(f"<b>{heading.group(1)}</b>")
            continue
        lines.append(re.sub(r"^(\s*)[-*]\s+", r"\1• ", line))
    out = "\n".join(lines)
    out = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", out, flags=re.S)
    out = re.sub(r"`([^`\n]+)`", r"<code>\1</code>", out)
    return re.sub(r"\n{3,}", "\n\n", out).strip()


def _telegram_watch(cfg: dict, pending: dict[str, dict]) -> None:
    """Track live progress for runs this poller started.

    One message per run, edited in place as steps land -- 11 nodes would otherwise
    mean 22 notifications, and nobody reads those. Step FAILURES get their own
    message so they can't scroll past unnoticed.
    """
    for run_id, state in list(pending.items()):
        try:
            run = _api_get(cfg, f"/api/workflow-runs/{run_id}")
            steps = _api_get(cfg, f"/api/workflow-runs/{run_id}/steps")
        except Exception:
            continue  # transient; retry next tick

        status = str(run.get("status") or "")
        icon = {"completed": "✅", "running": "🔄", "failed": "❌",
                "waiting_approval": "⏸", "cancelled": "⏹"}

        # A newly failed step is worth its own message.
        for step in steps:
            name = str(step.get("agent_name") or step.get("node_id"))
            if step.get("status") == "failed" and name not in state["failed"]:
                state["failed"].add(name)
                detail = str(step.get("error") or step.get("summary") or "").strip()
                text = f"<b>❌ {name} failed</b>"
                if detail:
                    text += "\n\n" + _md_to_telegram_html(detail[:1200])
                _telegram_send(cfg, state["chat_id"], text)

        lines = [f"<b>{icon.get(status, '🔄')} {state['name']} — run {run_id[:8]}</b>", ""]
        for step in steps:
            lines.append(f"{icon.get(str(step.get('status')), '　')} "
                         f"{_md_to_telegram_html(str(step.get('agent_name') or step.get('node_id')))}")
        body = "\n".join(lines)

        if body != state.get("last_body"):
            state["last_body"] = body
            if state.get("message_id"):
                _telegram_edit(cfg, state["chat_id"], state["message_id"], body)
            else:
                state["message_id"] = _telegram_send(cfg, state["chat_id"], body)

        if status not in ("completed", "failed", "cancelled"):
            continue
        pending.pop(run_id, None)

        summary = str(run.get("final_report") or "").strip()
        if summary:
            _telegram_send(cfg, state["chat_id"],
                           f"<b>{icon.get(status, '')} Result</b>\n\n"
                           + _md_to_telegram_html(summary[:3500]))


def _api_get(cfg: dict, path: str):
    req = urllib.request.Request(
        f"{cfg['backend_url'].rstrip('/')}{path}",
        headers={"Authorization": f"Bearer {cfg['api_token']}"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode())


# Every reply ends with this so the workflow list is always one tap away.
_TG_FOOTER = "\n\n<i>/list — show workflows</i>"


def _telegram_send(cfg: dict, chat_id: int, text: str, footer: bool = True) -> int | None:
    """Send an HTML message; returns its message_id so it can be edited later."""
    if footer and "/list —" not in text:
        text += _TG_FOOTER
    try:
        resp = _telegram_call(cfg["bot_token"], "sendMessage",
                              {"chat_id": chat_id, "text": text, "parse_mode": "HTML",
                               "link_preview_options": {"is_disabled": True}}, timeout=15)
        return (resp.get("result") or {}).get("message_id")
    except Exception as exc:
        log_event("warn", f"Telegram send failed: {exc}")
        return None


def _telegram_edit(cfg: dict, chat_id: int, message_id: int, text: str) -> None:
    try:
        _telegram_call(cfg["bot_token"], "editMessageText",
                       {"chat_id": chat_id, "message_id": message_id, "text": text,
                        "parse_mode": "HTML",
                        "link_preview_options": {"is_disabled": True}}, timeout=15)
    except Exception:
        pass  # "message is not modified" and races are not worth surfacing


def _telegram_poll() -> None:
    """Long-poll Telegram and start a run per allowlisted message.

    Long-poll, not webhook: no public URL, works behind NAT, and this process is
    already launchd-supervised. Only chats in allowed_chat_ids may trigger a run --
    this is an inbound execution path into the host.
    """
    offset = 0
    failures = 0
    pending: dict[str, dict] = {}   # run_id -> {chat_id, name, message_id, failed}
    awaiting: dict[int, dict] = {}  # chat_id -> workflow chosen, waiting for its input
    while True:
        cfg = _telegram_config()
        if not cfg:
            time.sleep(60)  # not configured; re-check in case it appears
            continue
        try:
            _telegram_watch(cfg, pending)
            # Short poll while a run is in flight so the result lands promptly.
            resp = _telegram_call(cfg["bot_token"], "getUpdates",
                                  {"offset": offset, "timeout": 5 if pending else 30},
                                  timeout=40)
            failures = 0
            for update in resp.get("result", []):
                offset = update["update_id"] + 1
                msg = update.get("message") or {}
                chat_id = (msg.get("chat") or {}).get("id")
                text = str(msg.get("text") or "").strip()
                if not text:
                    continue
                if chat_id not in cfg["allowed_chat_ids"]:
                    log_event("warn", "Telegram message from non-allowlisted chat rejected",
                              chat_id=chat_id)
                    continue
                # A prior bare command is waiting for its input.
                chosen = awaiting.pop(chat_id, None)
                if chosen and not text.startswith("/"):
                    reply, started_run = _telegram_start_run(cfg, chosen, text)
                    if started_run:
                        pending[started_run] = {"chat_id": chat_id, "name": chosen["name"],
                                                "message_id": None, "failed": set(), "last_body": ""}
                    _telegram_send(cfg, chat_id, reply)
                    continue
                if chosen and text.lower() == "/run":
                    reply, started_run = _telegram_start_run(cfg, chosen, "")
                    if started_run:
                        pending[started_run] = {"chat_id": chat_id, "name": chosen["name"],
                                                "message_id": None, "failed": set(), "last_body": ""}
                    _telegram_send(cfg, chat_id, reply)
                    continue

                targets = _telegram_targets(cfg)

                if text.lower() in ("/list", "/start", "/help"):
                    if targets:
                        rows = "\n".join(
                            f"/{t['name'].replace(' ', '_')} — sets <code>{t['field']}</code>"
                            for t in targets
                        )
                        body = f"<b>Workflows you can trigger</b>\n\n{rows}"
                        if len(targets) == 1:
                            body += "\n\nOnly one, so a plain message runs it."
                    else:
                        body = ("No workflow has a Telegram trigger node yet. "
                                "Add one in the builder and save.")
                    _telegram_send(cfg, chat_id, body)
                    continue

                if not targets:
                    reply = "No workflow has a Telegram trigger node. Add one and save."
                elif len(targets) > 1 and not text.startswith("/"):
                    names = ", ".join(f"/{t['name'].replace(' ', '_')}" for t in targets[:8])
                    reply = f"Several workflows accept Telegram input. Prefix with one of: {names}"
                else:
                    if text.startswith("/"):
                        cmd, _, rest = text[1:].partition(" ")
                        match = [t for t in targets if t["name"].replace(" ", "_").lower() == cmd.lower()]
                        if not match:
                            _telegram_send(cfg, chat_id, f"No Telegram workflow named <b>{cmd}</b>.")
                            continue
                        targets, text = match, rest.strip()
                        if not text:
                            # Bare command: ask rather than silently running with no
                            # input, which reads as the workflow ignoring the user.
                            awaiting[chat_id] = match[0]
                            _telegram_send(
                                cfg, chat_id,
                                f"<b>{match[0]['name']}</b>\n\nSend the "
                                f"<code>{match[0]['field']}</code> for this run, "
                                "or <code>/run</code> to start with none.",
                            )
                            continue
                    reply, started_run = _telegram_start_run(cfg, targets[0], text)
                    if started_run:
                        pending[started_run] = {"chat_id": chat_id, "name": targets[0]["name"],
                                                "message_id": None, "failed": set(), "last_body": ""}
                log_event("info", "Telegram trigger", chat_id=chat_id, result=reply)
                try:
                    _telegram_call(cfg["bot_token"], "sendMessage",
                                   {"chat_id": chat_id, "text": reply}, timeout=15)
                except Exception:
                    pass  # reply is best-effort; the run already started
        except Exception as exc:
            failures += 1
            log_event("warn", f"Telegram poll failed ({failures}): {exc}")
            time.sleep(min(60, 5 * failures))


def _ensure_sbx_daemon() -> None:
    """Supervise the sbx daemon: start it at boot and restart it if it dies.

    The daemon has no service of its own, so without this a crash leaves the
    sandbox runtime down until someone notices. Backs off after repeated
    failures so a genuinely broken install does not respawn in a tight loop.
    """
    failures = 0
    while True:
        try:
            if not best_sbx_candidate()[0]:
                return  # sbx not installed; nothing to supervise

            if sbx_daemon_running():
                if failures:
                    log_event("info", "sbx daemon recovered")
                failures = 0
            else:
                result = sbx_daemon_start()
                if result.get("ok"):
                    failures = 0
                    log_event("info", f"sbx daemon started by supervisor: {result.get('message')}")
                else:
                    failures += 1
                    log_event("warn", f"sbx daemon restart failed ({failures}): {result.get('message')}")
        except Exception as exc:  # never take the runner down over this
            failures += 1
            log_event("warn", f"sbx daemon supervisor error: {exc}")

        # Steady 30s polling; exponential backoff up to ~5min while it keeps failing.
        delay = SBX_SUPERVISE_INTERVAL * (2 ** min(failures, SBX_SUPERVISE_BACKOFF_MAX))
        time.sleep(min(delay, 300.0) if failures else SBX_SUPERVISE_INTERVAL)


if __name__ == "__main__":
    import sys as _sys
    if len(_sys.argv) > 1 and _sys.argv[1] == "--version":
        print(HOST_RUNNER_VERSION)
        raise SystemExit(0)
    if len(_sys.argv) > 1 and _sys.argv[1] == "--self-check":
        # Frontmatter parsing is the only non-obvious logic in the repo-import path.
        # The hard case is a double-quoted description that spans lines and embeds an
        # <example> block with literal \n escapes.
        meta, body = _split_frontmatter(
            '---\n'
            'name: blog-writer\n'
            'description: "Use this agent to draft a post.\\n\\n<example>\\n'
            'user: \\"write a post\\"\\n'
            '</example>"\n'
            'color: blue\n'
            '---\n'
            '# Body\nInstructions here.\n'
        )
        assert meta["name"] == "blog-writer", meta
        assert meta["color"] == "blue", meta
        assert "</example>" in meta["description"], meta["description"]
        assert body.startswith("# Body"), body

        simple, simple_body = _split_frontmatter("---\nname: x\nclass: review\n---\nbody\n")
        assert simple == {"name": "x", "class": "review"}, simple
        assert simple_body == "body", simple_body
        assert _split_frontmatter("no frontmatter here")[0] == {}

        for bad_url in ("http://github.com/a/b", "https://evil.com/a/b", "https://github.com/onlyowner"):
            assert clone_agent_repository({"repo_url": bad_url})["ok"] is False, bad_url

        # Telegram config must be inert unless fully specified -- a half-written
        # config must never enable an inbound execution path.
        import tempfile as _tf
        _orig = globals()["TELEGRAM_CONFIG"]
        try:
            for cfg, want in (
                ({}, False),
                ({"bot_token": "x"}, False),                      # no allowlist
                ({"allowed_chat_ids": [1]}, False),               # no token
                ({"bot_token": "x", "allowed_chat_ids": []}, False),  # empty allowlist
                ({"bot_token": "x", "allowed_chat_ids": [1]}, True),
            ):
                with _tf.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
                    json.dump(cfg, fh)
                    globals()["TELEGRAM_CONFIG"] = Path(fh.name)
                assert bool(_telegram_config()) is want, cfg
                Path(fh.name).unlink()
            globals()["TELEGRAM_CONFIG"] = Path("/nonexistent/telegram.json")
            assert _telegram_config() == {}
        finally:
            globals()["TELEGRAM_CONFIG"] = _orig

        # Secrets must never survive into the HTTP-served log.
        for secret, sample in (
            ("111222333:AAEEabcdefghijklmnopqrstuvwxyz123456789",
             "poll failed for 111222333:AAEEabcdefghijklmnopqrstuvwxyz123456789"),
            ("Bearer U3e2uS0vVnz0KrM2ZKfLv7U0Hto",
             "auth Bearer U3e2uS0vVnz0KrM2ZKfLv7U0Hto rejected"),
            ("/bot999888:XYZ", "GET /bot999888:XYZ/getUpdates"),
        ):
            assert secret not in _scrub(sample), sample
        assert _scrub("nothing secret here") == "nothing secret here"

        html = _md_to_telegram_html(
            "## Scoping Pass\n**Critical:** see `README.md`\n- first\n* second\n\n\n\nend <tag> & more"
        )
        assert "<b>Scoping Pass</b>" in html, html
        assert "<b>Critical:</b>" in html, html
        assert "<code>README.md</code>" in html, html
        assert html.count("• ") == 2, html
        assert "&lt;tag&gt;" in html and "&amp;" in html, html
        assert "\n\n\n" not in html, html

        print("self-check OK")
        raise SystemExit(0)
    if len(_sys.argv) > 1 and _sys.argv[1] == "--install-service":
        result = launchd_install()
        print(result["message"])
        raise SystemExit(0 if result["ok"] else 1)
    main()
