"""Who may drive execution, and where it may run.

Both gates live here rather than in the caller, because this is the layer that
spawns a process as the host user. A caller that could be trusted to check would
not need the check.

Enforced identically whether the backend imports this directly (native) or the
host shim does on its behalf (Docker) — the same reason the module exists.
"""

from __future__ import annotations

import json
import os
import secrets
import sys
from pathlib import Path

# Where the token lives depends on how the backend was deployed, so resolution is
# ordered rather than fixed:
#   1. SPECTER_RUNNER_TOKEN_FILE  — explicit wins
#   2. /app/secrets/runner-token  — the mount a containerized backend can read;
#                                   ~/.specter is on the HOST and invisible to it
#   3. ~/.specter/runner-token    — the native default, and where the runner
#                                   writes when nothing overrides it
#
# The extraction of this module briefly lost this and kept only the runner's own
# path, which silently broke the containerized backend: it looked in /root and
# ignored the mounted file sitting beside it.
def _token_candidates() -> list[Path]:
    out = []
    override = os.environ.get("SPECTER_RUNNER_TOKEN_FILE")
    if override:
        out.append(Path(override))
    out.append(Path("/app/secrets/runner-token"))
    out.append(Path.home() / ".specter" / "runner-token")
    return out


# The path this process WRITES to. Readers use _token_candidates().
RUNNER_TOKEN_FILE = _token_candidates()[0]

# The approved-workspace list, synced from the backend. Overridable for the same
# reason as the token: a containerized backend cannot see the host's $HOME.
WORKSPACES_CONFIG = Path(
    os.environ.get("SPECTER_WORKSPACES_CONFIG", str(Path.home() / ".specter" / "workspaces.json"))
)

RUNNER_AUTH_HEADER = "X-Specter-Runner-Token"

# Reachable without a token: liveness and version only. They expose nothing and
# spawn nothing, and the backend needs /health before it holds a token.
UNAUTHENTICATED_PATHS = {"/health", "/version"}


def runner_token() -> str | None:
    """The shared secret, or None if the runner has not been provisioned."""
    for candidate in _token_candidates():
        try:
            token = candidate.read_text(encoding="utf-8").strip()
            if token:
                return token
        except OSError:
            continue
    return None


def ensure_runner_token() -> str:
    """Read the token, minting one on first start.

    Written 0600 -- it is the only thing standing between a local process and
    an agent running as this user.
    """
    existing = runner_token()
    if existing:
        return existing
    RUNNER_TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    token = secrets.token_urlsafe(32)
    RUNNER_TOKEN_FILE.write_text(token, encoding="utf-8")
    try:
        RUNNER_TOKEN_FILE.chmod(0o600)
    except OSError:
        pass
    return token


def approved_workspaces() -> list[Path] | None:
    """Approved roots, synced from the backend.

    Returns None when the file is absent or unreadable -- distinct from an empty
    list. Callers must FAIL CLOSED on None: a missing config means "not
    provisioned yet", never "allow everything".
    """
    try:
        raw = json.loads(WORKSPACES_CONFIG.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    paths = raw.get("paths") if isinstance(raw, dict) else raw
    if not isinstance(paths, list):
        return None
    out = []
    for entry in paths:
        if isinstance(entry, str) and entry.strip():
            out.append(Path(entry).expanduser().resolve())
    return out


def approved_workspace(path: str) -> tuple[Path | None, str]:
    """Resolve a requested workspace against the allowlist.

    Returns (resolved_path, "") when approved, or (None, reason) when not.

    Mirrors _approved_workspace_path in backend/app/routers/runs.py: a request is
    approved if it IS an approved root or sits inside one. Resolved first, so a
    symlink cannot point outside an approved tree and still match.
    """
    if not path or not str(path).strip():
        return None, "Workspace path is required."

    requested = Path(str(path)).expanduser().resolve()
    roots = approved_workspaces()

    if roots is None:
        return None, (
            "This runner has no approved-workspace list yet. Start the Specter "
            f"backend once to sync it, or write {WORKSPACES_CONFIG} yourself."
        )
    if not roots:
        return None, "No repositories are approved for agent execution."

    for root in roots:
        if requested == root or root in requested.parents:
            return requested, ""

    return None, f"Workspace path is not approved for agent execution: {requested}"



# ── self-check ───────────────────────────────────────────────────────────────
# Run:  python3 specter_exec/allowlist.py --self-check
#
# Every case here is a real failure. The extraction of this module out of the
# host runner dropped the multi-location token lookup and silently broke the
# containerized backend — it read /root/.specter and ignored the mounted file
# beside it. Nothing caught that, so these exist.

def _demo() -> None:
    import tempfile

    global WORKSPACES_CONFIG
    failed = 0

    def check(name: str, got, want) -> None:
        nonlocal failed
        ok = got == want
        print(f"  {'✓' if ok else '✗'} {name}" + ("" if ok else f"  got {got!r}, want {want!r}"))
        if not ok:
            failed += 1

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp).resolve()
        (root / "repo" / "sub").mkdir(parents=True)
        (root / "other").mkdir()

        cfg = root / "workspaces.json"
        cfg.write_text(json.dumps({"paths": [str(root / "repo")]}))

        original = WORKSPACES_CONFIG
        WORKSPACES_CONFIG = cfg
        try:
            check("an approved root is allowed",
                  approved_workspace(str(root / "repo"))[0] is not None, True)
            check("a subdirectory of it is allowed",
                  approved_workspace(str(root / "repo" / "sub"))[0] is not None, True)
            check("an unapproved sibling is rejected",
                  approved_workspace(str(root / "other"))[0], None)
            # Resolved before comparison, or '..' walks straight out of the root.
            check("traversal out of an approved root is rejected",
                  approved_workspace(str(root / "repo" / ".." / "other"))[0], None)
            check("an empty path is rejected", approved_workspace("")[0], None)

            # Fail CLOSED. A missing config means "not provisioned", never
            # "allow everything" — the whole point of the gate.
            WORKSPACES_CONFIG = root / "does-not-exist.json"
            path, reason = approved_workspace(str(root / "repo"))
            check("a missing allowlist rejects rather than allows", path, None)
            check("and says what to do about it", "sync" in reason.lower(), True)

            # A corrupt file is also "not provisioned", not "allow everything".
            bad = root / "bad.json"
            bad.write_text("{not json")
            WORKSPACES_CONFIG = bad
            check("a corrupt allowlist fails closed",
                  approved_workspace(str(root / "repo"))[0], None)
        finally:
            WORKSPACES_CONFIG = original

        # THE REGRESSION: a containerized backend reads a mounted path, not $HOME.
        tok = root / "runner-token"
        tok.write_text("token-from-an-alternate-location")
        os.environ["SPECTER_RUNNER_TOKEN_FILE"] = str(tok)
        try:
            check("the token is found via SPECTER_RUNNER_TOKEN_FILE",
                  runner_token(), "token-from-an-alternate-location")
        finally:
            del os.environ["SPECTER_RUNNER_TOKEN_FILE"]

    print(f"\n  {'FAILED' if failed else 'all checks passed'}"
          + (f" — {failed} assertion(s)" if failed else ""))
    raise SystemExit(1 if failed else 0)


if __name__ == "__main__" and "--self-check" in sys.argv:
    _demo()
