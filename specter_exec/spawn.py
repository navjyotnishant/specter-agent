"""Run a subprocess to completion, streaming its output under a deadline.

The mechanics of running an agent, separated from knowing which agents exist.
Given a command, it streams stdout line by line, drains stderr on a thread, kills
the process if it overruns, and returns what happened.

WHY A THREAD FOR STDERR
A subprocess writing more to stderr than the pipe buffer holds blocks forever
while the parent reads stdout. Draining both concurrently is what stops a chatty
agent deadlocking a run.

WHY THE DEADLINE IS CHECKED WHILE READING
Between lines is the only place a streaming reader can notice time passing.
subprocess.run(timeout=) would be simpler but cannot stream, and streaming is the
point: a run that takes minutes has to show progress while it works.

Run:  python3 specter_exec/spawn.py --self-check
"""

from __future__ import annotations

import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

# Enough to diagnose a failure without storing a whole build log in a DB row.
STDOUT_LIMIT = 20000
STDERR_LIMIT = 12000
# One progress line is a line, not a file.
LINE_LIMIT = 2000


@dataclass
class SpawnResult:
    """What happened. No transport shape — the caller decides how to report it."""

    exit_code: int | None
    stdout: str
    stderr: str
    timed_out: bool = False
    error: str = ""          # set only when the process could not start
    lines: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.exit_code == 0 and not self.timed_out and not self.error


def run_streaming(
    command: list[str],
    cwd: str | Path,
    timeout_seconds: int,
    on_stdout: Callable[[str], None] | None = None,
    on_stderr: Callable[[str], None] | None = None,
    on_proc: Callable[[subprocess.Popen], None] | None = None,
) -> SpawnResult:
    """Run `command` in `cwd`, streaming each line as it arrives.

    on_proc receives the live process before any output — that is what makes
    cancellation possible. Without it a caller can only wait for the deadline,
    which is the difference between a stoppable run and a stuck one.

    A failure to spawn returns a result with `error` set rather than raising:
    "claude is not installed" and "claude exited 1" are both outcomes the caller
    reports the same way.
    """
    stdout_lines: list[str] = []
    stderr_lines: list[str] = []
    timed_out = False

    try:
        proc = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            cwd=str(cwd),
        )
    except Exception as exc:  # noqa: BLE001 - missing binary, bad cwd, no permission
        return SpawnResult(exit_code=None, stdout="", stderr="", error=str(exc))

    if on_proc:
        on_proc(proc)

    def drain_stderr() -> None:
        for raw in proc.stderr:  # type: ignore[union-attr]
            line = raw.rstrip()
            stderr_lines.append(line)
            if on_stderr and line:
                on_stderr(line[:LINE_LIMIT])

    stderr_thread = threading.Thread(target=drain_stderr, daemon=True)
    stderr_thread.start()

    deadline = time.monotonic() + timeout_seconds
    try:
        for raw in proc.stdout:  # type: ignore[union-attr]
            line = raw.rstrip()
            stdout_lines.append(line)
            if on_stdout:
                on_stdout(line)
            if time.monotonic() > deadline:
                proc.kill()
                timed_out = True
                break
        proc.wait()
        # Bounded: a stderr thread blocked on a pipe must not hold the run open.
        stderr_thread.join(timeout=2)
    except Exception as exc:  # noqa: BLE001
        try:
            proc.kill()
        except Exception:  # noqa: BLE001
            pass
        return SpawnResult(exit_code=None, stdout="\n".join(stdout_lines),
                           stderr="\n".join(stderr_lines), error=str(exc))

    return SpawnResult(
        exit_code=proc.returncode,
        stdout="\n".join(stdout_lines)[-STDOUT_LIMIT:],
        stderr="\n".join(stderr_lines)[-STDERR_LIMIT:],
        timed_out=timed_out,
        lines=stdout_lines,
    )


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
        r = run_streaming(["echo", "hello"], tmp, 10)
        check("captures stdout", r.stdout, "hello")
        check("reports success", r.ok, True)
        check("exit code 0", r.exit_code, 0)

        r = run_streaming(["sh", "-c", "exit 3"], tmp, 10)
        check("captures a non-zero exit", r.exit_code, 3)
        check("and is not ok", r.ok, False)

        r = run_streaming(["sh", "-c", "echo oops >&2"], tmp, 10)
        check("captures stderr separately", r.stderr, "oops")

        seen: list[str] = []
        run_streaming(["sh", "-c", "echo one; echo two"], tmp, 10, on_stdout=seen.append)
        check("streams each line as it arrives", seen, ["one", "two"])

        # THE DEADLOCK CASE. More stderr than the pipe buffer holds: without a
        # draining thread this hangs forever rather than failing.
        # Bounded generator, not `yes | head`: `yes` never exits on its own, so
        # that version left a process spinning after head closed the pipe --
        # my own test hung, not the module.
        r = run_streaming(
            ["python3", "-c",
             "import sys\nfor i in range(20000): sys.stderr.write('noise line %d\\n' % i)"],
            tmp, 15)
        check("a chatty stderr does not deadlock", r.exit_code, 0)

        # THE DEADLINE. Must kill, not wait for the process to finish.
        start = time.monotonic()
        r = run_streaming(["sh", "-c", "for i in 1 2 3 4 5 6 7 8; do echo tick; sleep 1; done"],
                          tmp, 2)
        elapsed = time.monotonic() - start
        check("overrunning is reported as a timeout", r.timed_out, True)
        check("and is not ok", r.ok, False)
        check("and does not wait for the full command", elapsed < 6, True)

        # A missing binary is an outcome, not an exception to handle upstream.
        r = run_streaming(["definitely-not-a-real-binary-xyz"], tmp, 5)
        check("a missing binary returns an error result", bool(r.error), True)
        check("rather than raising", r.ok, False)
        check("with no exit code", r.exit_code, None)

        # CANCELLATION: on_proc must fire before output, or a caller has nothing
        # to kill while the run is in flight.
        captured = {}
        run_streaming(["echo", "x"], tmp, 10, on_proc=lambda p: captured.setdefault("proc", p))
        check("the live process is handed to the caller", "proc" in captured, True)

    print(f"\n  {'FAILED' if failed else 'all checks passed'}"
          + (f" — {failed} assertion(s)" if failed else ""))
    raise SystemExit(1 if failed else 0)


if __name__ == "__main__" and "--self-check" in sys.argv:
    _demo()
