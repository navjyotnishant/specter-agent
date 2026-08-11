# The execution engine

`internal/exec` is everything needed to run an agent on this machine, and nothing
about how the request arrived. The CLI imports it directly. So does the server.

That is the whole design: **one implementation, two entry points**, with no HTTP
between a caller and a subprocess it is about to spawn on the same machine.

```
  specter run   ──import──► exec ──► claude / codex / cursor / gemini
  specter serve ──import──►  ▲
                             │
                       same package, same process
```

There used to be a second path. The Python backend ran inside a container, and a
container has no agent binary and no credentials — verified: `which claude`
inside it returns nothing, and `~/.claude` does not exist there. It **cannot**
run an agent. So it posted to a host process on `host.docker.internal:8765`,
which imported the engine and spawned the agent on its behalf.

That bridge is gone. Not because the constraint changed — a container still has
no agent binary — but because the constraint moved: the binary that spawns
agents now runs on the host in the first place. `specter serve` is the server,
and it is on the machine that has the agents. A containerized deployment is for
the API and the web UI; agent execution happens where the credentials are.

The bridge was worth removing on its own terms. It was a second process to keep
alive, a second thing to install, a port to bind, and an entire class of failure
where the app was running and the runner was not — reported by users as "the
agent doesn't work" with nothing in the app's own logs.

---

## Why these decisions were made

Each of the following is a real failure, found by testing rather than review. They
are recorded here because the code that prevents them looks arbitrary without the
story, and the next person to "simplify" one of them will reintroduce the bug.

### An explicit override must be authoritative

`SPECTER_RUNNER_TOKEN_FILE` names where the shared secret lives. The first
implementation treated it as a *preference*: if the named file was missing, the
search continued to `/app/secrets/runner-token`, then `~/.specter/runner-token`.

A test pointed the variable at a nonexistent path and expected no token. It found
one — the developer's real credential, two candidates down the chain.

Silently reading a credential the operator did not point at is worse than finding
none. A container misconfigured this way would appear to work while using the
wrong secret.

> **Rule:** an override returns exactly one candidate. Absent means absent.

### Paths are resolved before they are compared

`/tmp` is a symlink to `/private/tmp` on macOS. `t.TempDir()` hands back
`/var/folders/...`, which resolves to `/private/var/folders/...`.

Comparing an unresolved requested path against a resolved approved root fails for
reasons unrelated to the rule being tested. Worse, without resolution
`approved/../elsewhere` walks straight out of an approved root, and a symlink
inside one points anywhere on the filesystem.

This becomes sharper still in the confinement layer: **`sandbox-exec` matches on
resolved paths, and a profile written with an unresolved path fails open — no
error, no warning, no protection.** That is how a security feature ships and
protects nothing.

> **Rule:** `filepath.EvalSymlinks` before any path comparison, everywhere.

### A missing config is not permission

The approved-workspace allowlist is synced from the server. When the file is
absent — fresh install, server never started — the engine rejects every run with
a message naming what to do.

The tempting alternative is to treat "no allowlist" as "no restrictions". That
inverts a security gate into a security hole at exactly the moment it is least
likely to be noticed.

A corrupt file is treated identically. Unparseable is not permissive.

> **Rule:** fail closed, and say what would open it.

### A kill that fails must still close the job

Cancelling a run marks it done whether or not anything was actually signalled.

A process that cannot be signalled is already gone or unreachable. Leaving the job
open strands every caller polling for output that will never arrive — the UI
spins, the CLI hangs, and the run looks alive because nothing declared it dead.

> **Rule:** the failure path still reaches a terminal state.

### Both pipes drain concurrently

A subprocess writing more to stderr than the pipe buffer holds blocks forever
while the parent reads stdout. It is not slow; it is stopped, permanently, and it
looks like a hung agent.

The Python self-check for this initially used `yes error | head`, which hung the
*test* — `yes` never exits, so it kept running after `head` closed the pipe and
left runaway processes behind. Replaced with a bounded generator.

> **Rule:** stdout and stderr are drained by separate goroutines, always.

### A deadline must not depend on output arriving

The Python implementation checked the clock between stdout lines. That only
notices time passing *while output is arriving* — a silent agent could overrun its
deadline indefinitely, because the check lived inside the read loop.

`exec.CommandContext` fires regardless, and the same mechanism serves
cancellation, so a stuck run can be stopped mid-flight rather than only at a
deadline that may never be evaluated.

> **Rule:** deadlines are enforced by the runtime, not by the read loop.

### Not everything on stdout is an event

Agents that speak the Codex protocol emit newline-delimited JSON. Agents that do
not, emit prose.

Only a line beginning `{` is parsed as an event. A line beginning `[` is treated
as text, even though it looks like JSON — showing a stray bracket beats swallowing
real output from an agent whose entire progress display would otherwise be empty.

A truncated JSON write is skipped rather than raised on. This parses a live
subprocess whose format is not ours; failing on a partial line would fail a run
that was doing fine.

> **Rule:** tolerant parsing. Dropping output is the worse failure.

### `exec.LookPath` is not enough

Under launchd, a process inherits `PATH=/usr/bin:/bin:/usr/sbin:/sbin` — none of
the places a developer's CLIs live. `LookPath` alone reports every Homebrew- and
npm-installed agent as "not installed" while it sits in `/opt/homebrew/bin`.

The explicit install roots are the fix. PATH is still tried first, so a
developer's own build wins.

A readable-but-not-executable file is not a match. Returning it would surface as
"permission denied" at spawn time instead of a clear "not installed".

> **Rule:** PATH first, then the known roots, and check the executable bit.

### Go-specific hazards that Python did not have

| Hazard | Symptom | Fix |
|---|---|---|
| `bufio.Scanner` caps lines at 64 KiB | scanning stops silently; run output truncates | buffer raised to 4 MiB |
| JSON numbers decode as `float64` | `42.000000 output tokens` | format as integer |
| `proc.Wait()` after a context kill | exit code reflects the signal, not the agent | check `ctx.Err()` first |

---

## What this buys

**One binary.** The CLI and the server are the same artifact with different entry
points. No interpreter to ship, no venv, no version to match.

**Startup, measured rather than claimed** — 20 runs each on an M-series Mac:

| | median | best |
|---|---|---|
| Go binary | **6.7 ms** | 5.8 ms |
| Python CLI | 83.8 ms | 73.2 ms |

12.4x, and the Python figure is generous: it is the bare interpreter, not a
PyInstaller bundle, which additionally unpacks itself on every invocation. For a
command run dozens of times a day this is the difference between instant and
noticeable.

**No bridge natively.** Nothing needs to be running before a terminal command
works. The HTTP hop that a container requires costs 1.33 ms against a 244.8 s mean
run — 0.0005 %, measured — so its removal is not a performance decision. It is
about not requiring a daemon to run a subprocess.

**Cancellation that actually cancels.** A context threaded from the caller through
job tracking into the spawn means a stuck agent can be stopped from anywhere that
holds the token.

---

## Testing

```bash
go test -race ./internal/exec/...
```

Every rule above has a test. They were written **before** the implementations, and
caught a real design flaw in the first one — see the override rule above.

The suite is ported from 42 Python self-checks that ran in production on the
`epic-1-stop-losing-user-work` branch. When a Go port and the Python original
disagree, the Python behaviour is what shipped, and the test is the tiebreaker.
