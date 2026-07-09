# Primary author: Navjyot Nishant
# Created on: 2026-06-20
# Last updated: 2026-06-20 13:55 America/Chicago
# Description: Host prerequisite checker for Specter Agent local isolated runtime setup.
# AI usage: Built with assistance from AI tools for implementation acceleration, review, and refactoring.

from __future__ import annotations

import argparse
import json
import platform
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass
from typing import Any


HOST_RUNNER_URL = "http://127.0.0.1:8765"


@dataclass
class CheckResult:
    id: str
    label: str
    status: str
    required: bool
    message: str
    remediation: str | None = None
    details: dict[str, Any] | None = None


def run(command: list[str], timeout: int = 10) -> subprocess.CompletedProcess[str] | None:
    try:
        return subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=False)
    except Exception:
        return None


def which(command: str) -> str | None:
    return shutil.which(command)


def check_command(command: str, label: str, remediation: str, required: bool = True) -> CheckResult:
    path = which(command)
    if path:
        return CheckResult(command, label, "pass", required, f"Found at {path}.", details={"path": path})
    return CheckResult(command, label, "fail", required, f"{label} is not installed or not on PATH.", remediation)


def check_homebrew() -> CheckResult:
    if platform.system() != "Darwin":
        return CheckResult("homebrew", "Homebrew", "skip", False, "Homebrew is only required for the macOS install path.")
    return check_command("brew", "Homebrew", "Install Homebrew from https://brew.sh")


def check_docker_daemon() -> CheckResult:
    if not which("docker"):
        return CheckResult("docker_daemon", "Docker daemon", "fail", True, "Docker CLI is missing.", "Install and start Docker Desktop.")

    result = run(["docker", "version", "--format", "{{.Server.Version}}"], timeout=10)
    if result and result.returncode == 0 and result.stdout.strip():
        return CheckResult("docker_daemon", "Docker daemon", "pass", True, f"Docker daemon is reachable: {result.stdout.strip()}.")

    error = ((result.stderr if result else "") or "").strip()
    return CheckResult(
        "docker_daemon",
        "Docker daemon",
        "fail",
        True,
        "Docker daemon is not reachable.",
        "Start Docker Desktop, then re-run this check.",
        {"error": error},
    )


def check_docker_compose() -> CheckResult:
    if not which("docker"):
        return CheckResult("docker_compose", "Docker Compose", "fail", True, "Docker CLI is missing.", "Install Docker Desktop.")

    result = run(["docker", "compose", "version"], timeout=10)
    if result and result.returncode == 0:
        return CheckResult("docker_compose", "Docker Compose", "pass", True, result.stdout.strip() or "Docker Compose is available.")

    error = ((result.stderr if result else "") or "").strip()
    return CheckResult(
        "docker_compose",
        "Docker Compose",
        "fail",
        True,
        "Docker Compose is not available.",
        "Install or update Docker Desktop.",
        {"error": error},
    )


def check_sbx_cli() -> CheckResult:
    path = which("sbx")
    if path:
        return CheckResult("sbx_cli", "Docker Sandboxes CLI", "pass", True, f"Found at {path}.", details={"path": path})
    return CheckResult(
        "sbx_cli",
        "Docker Sandboxes CLI",
        "fail",
        True,
        "Docker Sandboxes CLI is not installed.",
        "Run: brew install docker/tap/sbx",
    )


def check_sbx_daemon() -> CheckResult:
    if not which("sbx"):
        return CheckResult("sbx_daemon", "Docker Sandboxes daemon", "fail", True, "sbx is missing.", "Run: brew install docker/tap/sbx")

    result = run(["sbx", "version"], timeout=10)
    output = "\n".join(part for part in [(result.stdout if result else ""), (result.stderr if result else "")] if part).strip()
    if result and result.returncode == 0 and "Server Version:" in output and "Server Version:  Unavailable" not in output:
        return CheckResult("sbx_daemon", "Docker Sandboxes daemon", "pass", True, "Docker Sandboxes daemon is reachable.", details={"version": output})

    return CheckResult(
        "sbx_daemon",
        "Docker Sandboxes daemon",
        "fail",
        True,
        "Docker Sandboxes daemon is not reachable.",
        "Run: sbx daemon start",
        {"output": output},
    )


def check_sbx_auth() -> CheckResult:
    if not which("sbx"):
        return CheckResult("sbx_auth", "Docker Sandboxes authentication", "fail", True, "sbx is missing.", "Run: brew install docker/tap/sbx")

    result = run(["sbx", "diagnose"], timeout=30)
    output = "\n".join(part for part in [(result.stdout if result else ""), (result.stderr if result else "")] if part)
    if result and result.returncode == 0 and "Authentication" in output and "authenticated" in output:
        return CheckResult("sbx_auth", "Docker Sandboxes authentication", "pass", True, "Docker Sandboxes is authenticated.")

    remediation = "Run: sbx login"
    if "daemon not running" in output.lower() or "Daemon unavailable" in output:
        remediation = "Run: sbx daemon start, then run: sbx login"
    return CheckResult(
        "sbx_auth",
        "Docker Sandboxes authentication",
        "fail",
        True,
        "Docker Sandboxes is not authenticated.",
        remediation,
        {"diagnostic": clean_ansi(output)[-2000:]},
    )


def check_sbx_policy() -> CheckResult:
    if not which("sbx"):
        return CheckResult("sbx_policy", "Docker Sandboxes network policy", "fail", True, "sbx is missing.", "Run: brew install docker/tap/sbx")

    result = run(["sbx", "policy", "ls"], timeout=10)
    output = "\n".join(part for part in [(result.stdout if result else ""), (result.stderr if result else "")] if part)
    if result and result.returncode == 0 and output.strip():
        policy = "custom"
        if "default-ai-services" in output and "default-package-managers" in output:
            policy = "balanced"
        elif "allow-all" in output or "default-allow-all" in output:
            policy = "allow-all"
        elif "deny-all" in output:
            policy = "deny-all"
        return CheckResult("sbx_policy", "Docker Sandboxes network policy", "pass", True, f"Network policy is configured: {policy}.")

    return CheckResult(
        "sbx_policy",
        "Docker Sandboxes network policy",
        "fail",
        True,
        "Docker Sandboxes default network policy is not configured.",
        "Run: sbx policy set-default balanced",
        {"output": clean_ansi(output)[-2000:]},
    )


def check_openai_secret(strict: bool) -> CheckResult:
    if not which("sbx"):
        return CheckResult("openai_sandbox_secret", "OpenAI sandbox secret", "warn", False, "sbx is missing.", "Install sbx first.")

    result = run(["sbx", "secret", "ls"], timeout=10)
    output = "\n".join(part for part in [(result.stdout if result else ""), (result.stderr if result else "")] if part)
    found = "openai" in output.lower()
    if found:
        return CheckResult("openai_sandbox_secret", "OpenAI sandbox secret", "pass", strict, "OpenAI sandbox secret is configured.")

    status = "fail" if strict else "warn"
    return CheckResult(
        "openai_sandbox_secret",
        "OpenAI sandbox secret",
        status,
        strict,
        "OpenAI/Codex sandbox secret is not configured yet.",
        "Run: sbx secret set -g openai --oauth",
    )


def check_host_runner(required: bool) -> CheckResult:
    try:
        with urllib.request.urlopen(f"{HOST_RUNNER_URL}/health", timeout=2) as response:
            payload = json.loads(response.read().decode("utf-8"))
        if payload.get("status") == "ok":
            return CheckResult("host_runner", "Specter host runner", "pass", required, "Host runner is reachable.", details=payload)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        return CheckResult(
            "host_runner",
            "Specter host runner",
            "fail" if required else "warn",
            required,
            "Specter host runner is not reachable on 127.0.0.1:8765.",
            "Run: python3 scripts/specter_host_runner.py",
            {"error": str(exc)},
        )

    return CheckResult(
        "host_runner",
        "Specter host runner",
        "fail" if required else "warn",
        required,
        "Specter host runner returned an unexpected response.",
        "Restart: python3 scripts/specter_host_runner.py",
    )


def clean_ansi(value: str) -> str:
    cleaned = []
    skip = False
    for char in value:
        if char == "\x1b":
            skip = True
            continue
        if skip and char.isalpha():
            skip = False
            continue
        if not skip:
            cleaned.append(char)
    return "".join(cleaned)


def collect_checks(strict: bool, require_host_runner: bool) -> list[CheckResult]:
    return [
        check_homebrew(),
        check_command("docker", "Docker CLI", "Install Docker Desktop."),
        check_docker_compose(),
        check_docker_daemon(),
        check_sbx_cli(),
        check_sbx_daemon(),
        check_sbx_auth(),
        check_sbx_policy(),
        check_openai_secret(strict),
        check_host_runner(require_host_runner),
    ]


def has_blockers(results: list[CheckResult]) -> bool:
    return any(result.required and result.status == "fail" for result in results)


def print_human(results: list[CheckResult]) -> None:
    symbols = {"pass": "PASS", "fail": "FAIL", "warn": "WARN", "skip": "SKIP"}
    print("Specter Agent prerequisite check")
    print("=" * 34)
    for result in results:
        required = "required" if result.required else "optional"
        print(f"{symbols.get(result.status, result.status.upper()):<5} {result.label} ({required})")
        print(f"      {result.message}")
        if result.remediation:
            print(f"      Next: {result.remediation}")
    print()
    if has_blockers(results):
        print("Setup is not ready. Complete the failed required items above, then re-run this check.")
    else:
        warnings = [result for result in results if result.status == "warn"]
        if warnings:
            print("Required prerequisites are ready. Complete warnings before running sandboxed agent tasks.")
        else:
            print("All checked prerequisites are ready.")


def main() -> int:
    parser = argparse.ArgumentParser(description="Check Specter Agent host prerequisites.")
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON.")
    parser.add_argument("--strict", action="store_true", help="Treat OpenAI/Codex sandbox secret as required.")
    parser.add_argument("--require-host-runner", action="store_true", help="Treat host runner availability as required.")
    args = parser.parse_args()

    results = collect_checks(strict=args.strict, require_host_runner=args.require_host_runner)
    if args.json:
        print(json.dumps({"ok": not has_blockers(results), "checks": [asdict(result) for result in results]}, indent=2))
    else:
        print_human(results)
    return 1 if has_blockers(results) else 0


if __name__ == "__main__":
    raise SystemExit(main())
