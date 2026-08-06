"""Parse the JSON event stream agents emit on stdout.

Codex (and the sandbox wrapper around other agents) writes newline-delimited JSON
events rather than prose. These turn that stream into the two things a caller
needs: progress lines to show while a run is in flight, and the final message or
error once it ends.

Deliberately tolerant. A malformed line is skipped rather than raised on: this
runs against a subprocess whose output format is not ours, and a parser that
throws on an unexpected line would fail a run that actually succeeded.

Run:  python3 specter_exec/agent_output.py --self-check
"""

from __future__ import annotations

import json
import sys
from typing import Callable

# How much of one item to keep as a progress line. Agent output can be a whole
# file; the progress view wants a line.
PROGRESS_LINE_LIMIT = 2000


def append_progress(line: str, emit: Callable[[str], None]) -> None:
    """Turn one raw stdout line into zero or one progress lines.

    `emit` receives what should be shown. Injected rather than writing to a job
    store directly, so this stays a parser.

    Non-JSON lines pass through unchanged: not every agent speaks the event
    protocol, and dropping their output would leave the progress view empty for
    exactly the agents that need it most.
    """
    stripped = line.strip()
    if not stripped:
        return
    if not stripped.startswith("{"):
        emit(stripped)
        return

    try:
        event = json.loads(stripped)
    except Exception:  # noqa: BLE001 - a partial write is not an error
        return
    if not isinstance(event, dict):
        return

    event_type = event.get("type", "")
    if event_type == "item.completed":
        item = event.get("item") or {}
        text = item.get("text") or item.get("content") or ""
        if text and isinstance(text, str):
            emit(text[:PROGRESS_LINE_LIMIT])
    elif event_type == "turn.completed":
        usage = event.get("usage") or {}
        emit(f"[turn completed - {usage.get('output_tokens', '?')} output tokens]")


def final_message(stdout: str) -> str:
    """The agent's last substantive message.

    The LAST agent_message wins: a run emits several as it works, and the final
    one is its answer.
    """
    found = ""
    for line in stdout.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        item = event.get("item") if isinstance(event, dict) else None
        if isinstance(item, dict) and item.get("type") == "agent_message":
            text = item.get("text")
            if isinstance(text, str):
                found = text
    return found


def error_message(stdout: str) -> str:
    """The failure reason, when the stream carries one.

    Two shapes: a bare `error` event, and `turn.failed` with the message nested
    under `error`. Both appear in practice.
    """
    found = ""
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
                found = message
        elif event.get("type") == "turn.failed":
            error = event.get("error")
            if isinstance(error, dict) and isinstance(error.get("message"), str):
                found = error["message"]
    return found


# ── self-check ───────────────────────────────────────────────────────────────

def _demo() -> None:
    failed = 0

    def check(name: str, got, want) -> None:
        nonlocal failed
        ok = got == want
        print(f"  {'✓' if ok else '✗'} {name}" + ("" if ok else f"  got {got!r}, want {want!r}"))
        if not ok:
            failed += 1

    def collect(line: str) -> list[str]:
        out: list[str] = []
        append_progress(line, out.append)
        return out

    # Plain output must survive: agents that do not speak the event protocol
    # would otherwise show nothing at all while they run.
    check("plain text passes through", collect("scanning 14 files"), ["scanning 14 files"])
    check("blank lines emit nothing", collect("   "), [])

    check("item.completed emits its text",
          collect(json.dumps({"type": "item.completed", "item": {"text": "did the thing"}})),
          ["did the thing"])
    check("item.completed falls back to content",
          collect(json.dumps({"type": "item.completed", "item": {"content": "via content"}})),
          ["via content"])
    check("turn.completed reports token usage",
          collect(json.dumps({"type": "turn.completed", "usage": {"output_tokens": 42}})),
          ["[turn completed - 42 output tokens]"])
    check("an unknown event type is silent",
          collect(json.dumps({"type": "something.else"})), [])

    # A truncated write must not raise: this parses a live subprocess stream,
    # and throwing here would fail a run that is doing fine.
    check("a truncated JSON line is skipped", collect('{"type": "item.comp'), [])
    # Only `{` marks an event; a line starting `[` is agent prose that happens to
    # look like JSON, and is shown rather than swallowed. Preserved from the
    # original — silently dropping output is worse than showing a stray bracket.
    check("a JSON array is shown as text", collect('["not", "a", "dict"]'), ['["not", "a", "dict"]'])

    # Long output is a progress LINE, not a file dump.
    long_text = "x" * 5000
    emitted = collect(json.dumps({"type": "item.completed", "item": {"text": long_text}}))
    check("long output is truncated", len(emitted[0]), PROGRESS_LINE_LIMIT)

    # The last agent_message is the answer; earlier ones are working notes.
    stream = "\n".join([
        json.dumps({"item": {"type": "agent_message", "text": "thinking"}}),
        "not json at all",
        json.dumps({"item": {"type": "agent_message", "text": "the answer"}}),
    ])
    check("final_message takes the last one", final_message(stream), "the answer")
    check("final_message is empty when absent", final_message("no events here"), "")

    check("error_message reads a bare error",
          error_message(json.dumps({"type": "error", "message": "rate limited"})),
          "rate limited")
    check("error_message reads turn.failed",
          error_message(json.dumps({"type": "turn.failed", "error": {"message": "quota exceeded"}})),
          "quota exceeded")
    check("error_message is empty on a clean run",
          error_message(json.dumps({"type": "turn.completed"})), "")

    print(f"\n  {'FAILED' if failed else 'all checks passed'}"
          + (f" — {failed} assertion(s)" if failed else ""))
    raise SystemExit(1 if failed else 0)


if __name__ == "__main__" and "--self-check" in sys.argv:
    _demo()
