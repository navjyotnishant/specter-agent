"""Locating agent CLIs on the host.

WHY THIS IS NOT JUST shutil.which
Under launchd the host runner inherits PATH=/usr/bin:/bin:/usr/sbin:/sbin — none
of the places a developer's CLIs actually live. shutil.which() alone therefore
reports every Homebrew- and npm-installed agent as "not installed" while it sits
in /opt/homebrew/bin. The explicit roots below are the fix, and the reason this
is a module rather than a one-liner.

The backend needs the same lookup when it runs natively and spawns agents itself,
so it lives here rather than in the runner.

Run:  python3 specter_exec/agents.py --self-check
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

# Where CLIs are actually installed, in the order to try. Homebrew first: on
# macOS it is where nearly everything lands.
CLI_INSTALL_ROOTS = [
    Path("/opt/homebrew/bin"),
    Path("/usr/local/bin"),
    Path.home() / ".local" / "bin",
    Path.home() / ".npm-global" / "bin",
    Path.home() / "bin",
]


def resolve_cli(*names: str, roots: list[Path] | None = None) -> str | None:
    """First match for any of `names`, or None.

    Several names because a CLI can ship under more than one (cursor-agent and
    cursor are the same tool). PATH is tried first so a developer's own override
    wins; the roots are a fallback for the launchd case above.
    """
    search_roots = CLI_INSTALL_ROOTS if roots is None else roots
    for name in names:
        found = shutil.which(name)
        if found:
            return found
        for root in search_roots:
            candidate = root / name
            if candidate.is_file() and os.access(candidate, os.X_OK):
                return str(candidate)
    return None


def claude_path() -> str | None:
    return resolve_cli("claude")


def cursor_path() -> str | None:
    return resolve_cli("cursor-agent", "cursor")


def gemini_path() -> str | None:
    return resolve_cli("gemini")


def codex_path() -> str | None:
    return resolve_cli("codex")


# ── self-check ───────────────────────────────────────────────────────────────

def _demo() -> None:
    import tempfile

    failed = 0

    def check(name: str, got, want) -> None:
        nonlocal failed
        ok = got == want
        print(f"  {'✓' if ok else '✗'} {name}" + ("" if ok else f"  got {got!r}, want {want!r}"))
        if not ok:
            failed += 1

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        exe = root / "faux-agent"
        exe.write_text("#!/bin/sh\nexit 0\n")
        exe.chmod(0o755)

        not_exec = root / "not-executable"
        not_exec.write_text("data")
        not_exec.chmod(0o644)

        # THE LAUNCHD CASE: not on PATH, but present in a known root.
        check("finds an executable in a known root",
              resolve_cli("faux-agent", roots=[root]), str(exe))
        check("returns None for something absent",
              resolve_cli("no-such-agent-anywhere", roots=[root]), None)
        # A readable-but-not-executable file is not a CLI; returning it would
        # produce a confusing "permission denied" at spawn time instead of a
        # clear "not installed".
        check("ignores a non-executable file",
              resolve_cli("not-executable", roots=[root]), None)
        # Several names for one tool — cursor-agent and cursor.
        check("tries each name in order",
              resolve_cli("missing", "faux-agent", roots=[root]), str(exe))

    # PATH must win, so a developer's own build overrides an installed one.
    check("PATH is preferred over the roots",
          resolve_cli("sh", roots=[Path("/nonexistent")]), shutil.which("sh"))

    print(f"\n  {'FAILED' if failed else 'all checks passed'}"
          + (f" — {failed} assertion(s)" if failed else ""))
    raise SystemExit(1 if failed else 0)


if __name__ == "__main__" and "--self-check" in sys.argv:
    _demo()
