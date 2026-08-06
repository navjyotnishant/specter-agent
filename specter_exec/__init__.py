"""Specter's execution engine — shared by the backend and the host shim.

WHY THIS PACKAGE EXISTS
The backend has no way to spawn an agent when it runs in a container: no agent
binary, no credentials, no access to the developer's repositories. So execution
lived in a separate host-side daemon, reached over HTTP.

That is right for the containerized deployment and pointless for the native one,
where the backend is already on the machine that has everything. This package is
the logic both need, with no HTTP in it:

    native      backend  ──import──►  specter_exec  ──►  claude
    docker      backend ──HTTP──► shim ──import──►  specter_exec  ──►  claude

One implementation, two entry points. Nothing here knows how it was called.

WHAT DOES NOT BELONG HERE
Anything that assumes a transport, a request, or a response shape. Functions take
plain values and return plain dicts, so the caller decides what to do with them.
"""

from .allowlist import approved_workspace, approved_workspaces, runner_token, ensure_runner_token

__all__ = [
    "approved_workspace",
    "approved_workspaces",
    "runner_token",
    "ensure_runner_token",
]
