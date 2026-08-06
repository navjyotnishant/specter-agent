"""In-flight run tracking: progress lines, cancellation, and the process handle.

WHY THIS IS SEPARATE
A run has to be observable while it happens (tail its output) and stoppable
(kill it). Both need the live subprocess handle, which only exists in the process
that spawned it — so this state is deliberately per-process, not shared.

That is also the crash-isolation trade this extraction makes. In the containerized
deployment the runner holds these jobs, so a runaway agent dies with the runner
and the API survives. Running natively, the backend holds them, and the timeout
and kill machinery below are what keep a stuck agent from becoming a stuck
Specter. They move with the code for exactly that reason.

Run:  python3 specter_exec/jobs.py --self-check
"""

from __future__ import annotations

import sys
import threading
from typing import Any, Callable

_LOCK = threading.Lock()
_JOBS: dict[str, dict[str, Any]] = {}

# The host runner scrubs secrets and writes to its own log ring; the backend logs
# differently. Injected rather than imported so this module needs neither.
_log: Callable[[str, str], None] = lambda level, message: None


def set_logger(fn: Callable[[str, str], None]) -> None:
    """Route progress lines to the caller's logger."""
    global _log
    _log = fn


def create(token: str) -> None:
    with _LOCK:
        _JOBS[token] = {"lines": [], "done": False, "proc": None}


def set_proc(token: str, proc: Any) -> None:
    """Record the live process, so it can be killed.

    Without this a cancel request has nothing to act on and the agent keeps
    running with nobody watching.
    """
    with _LOCK:
        if token in _JOBS:
            _JOBS[token]["proc"] = proc


def append(token: str, line: str) -> None:
    with _LOCK:
        if token in _JOBS:
            _JOBS[token]["lines"].append(line)
    if line.strip():
        _log("info", line.strip())


def done(token: str) -> None:
    with _LOCK:
        if token in _JOBS:
            _JOBS[token]["done"] = True
            _JOBS[token]["proc"] = None


def kill(token: str) -> bool:
    """Terminate a run. Returns False when the token is unknown.

    Marked done even if the kill throws: a process that cannot be signalled is
    already gone or unreachable, and leaving the job open would strand a caller
    waiting for output that will never arrive.
    """
    with _LOCK:
        job = _JOBS.get(token)
        if not job:
            return False
        proc = job.get("proc")
        if proc is not None:
            try:
                proc.kill()
            except Exception:  # noqa: BLE001
                pass
        job["done"] = True
        job["proc"] = None
    return True


def tail(token: str, since: int) -> dict[str, Any]:
    """Lines after `since`. An unknown token reports done, so a poller stops."""
    with _LOCK:
        job = _JOBS.get(token)
        if not job:
            return {"ok": False, "lines": [], "done": True}
        return {
            "ok": True,
            "lines": job["lines"][since:],
            "done": job["done"],
            "total": len(job["lines"]),
        }


# ── self-check ───────────────────────────────────────────────────────────────

def _demo() -> None:
    failed = 0

    def check(name: str, got, want) -> None:
        nonlocal failed
        ok = got == want
        print(f"  {'✓' if ok else '✗'} {name}" + ("" if ok else f"  got {got!r}, want {want!r}"))
        if not ok:
            failed += 1

    seen: list[str] = []
    set_logger(lambda level, message: seen.append(message))

    create("t1")
    append("t1", "first")
    append("t1", "second")
    check("tail returns appended lines", tail("t1", 0)["lines"], ["first", "second"])
    check("since skips what was already read", tail("t1", 1)["lines"], ["second"])
    check("progress reaches the injected logger", seen, ["first", "second"])

    # Blank lines are padding in agent output; logging them is noise.
    append("t1", "   ")
    check("blank lines are not logged", len(seen), 2)

    check("a live job is not done", tail("t1", 0)["done"], False)
    done("t1")
    check("done marks it finished", tail("t1", 0)["done"], True)

    # An unknown token must report done, or a poller spins forever.
    check("an unknown token reports done", tail("nope", 0)["done"], True)
    check("and reports not-ok", tail("nope", 0)["ok"], False)
    check("killing an unknown token is False", kill("nope"), False)

    # THE CANCELLATION PATH. Without set_proc there is nothing to kill, and a
    # runaway agent keeps running — the failure this whole module guards.
    class FakeProc:
        killed = False
        def kill(self) -> None:
            self.killed = True

    proc = FakeProc()
    create("t2")
    set_proc("t2", proc)
    check("kill returns True for a known job", kill("t2"), True)
    check("and actually signals the process", proc.killed, True)
    check("and marks the job done", tail("t2", 0)["done"], True)

    # A process that cannot be signalled must not strand the job open.
    class ExplodingProc:
        def kill(self) -> None:
            raise OSError("no such process")

    create("t3")
    set_proc("t3", ExplodingProc())
    check("a failed kill still returns True", kill("t3"), True)
    check("and still marks the job done", tail("t3", 0)["done"], True)

    print(f"\n  {'FAILED' if failed else 'all checks passed'}"
          + (f" — {failed} assertion(s)" if failed else ""))
    raise SystemExit(1 if failed else 0)


if __name__ == "__main__" and "--self-check" in sys.argv:
    _demo()
