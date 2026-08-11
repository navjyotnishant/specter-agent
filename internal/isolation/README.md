# internal/isolation — the Warden

What stands between an agent and the rest of your machine.

`Warden()` is the single report: every boundary, which hold, and what is exposed
by the ones that do not. `specter status` prints it and `GET
/api/runtime-adapters/warden` serves it, so the terminal and the browser cannot
disagree about what is protecting you.

Applied by every path that spawns an agent — `specter run`, the runner behind
`specter serve`, and the `specter agent-host` shim. For a while it was applied by
only the first, so a run started from the browser was less contained than the
same run from a terminal.

| File | What it holds |
|---|---|
| `policy.go` | **The rules.** What an agent may read, write and reach. |
| `seatbelt.go` | macOS mechanism — generates a `sandbox-exec` profile from the policy. |
| `bubblewrap.go` | Linux mechanism — the same policy as `bwrap` bind mounts. |
| `isolation.go` | Detection, dispatch, path safety, workspace resolution. |
| `network.go` | CONNECT-level filtering proxy — the boundary Seatbelt cannot express. |
| `warden.go` | The one report: every layer, which hold, what the others expose. |

Named for mechanisms rather than platforms: these files are **not** build-tagged,
they compile everywhere, and `Detect()` picks between them at runtime.

## The agent never touches your repository

```
your repo  ──clone──►  ~/.specter/runs/run-abc123/  ──► agent runs here, confined
```

`worktree.Prepare` makes a git worktree; the runner hands the AGENT that
worktree, never the source; the Warden's profile is built around it. Your
checkout is read exactly once, by Specter's own process, to create the clone.

This is why the approved-repository list was retired. It read as a permission to
operate inside a repository — but nothing ever operates inside your repository.
A repository is a SOURCE TO CLONE FROM, which is an input to a run like the
prompt, not an access grant.

A read-only run detaches at HEAD. A `--write` run gets its own branch, which is
what makes the pull-request path possible: the work arrives as a branch you
review, never as edits already in your tree.

## The one decision worth knowing

**Specter owns the policy. It does not implement the enforcement.**

Seatbelt and bubblewrap are kernel features, audited by people whose full-time
job that is. A hand-rolled replacement that is subtly wrong looks exactly like
one that works — until it does not, silently. So this package drives them.

What is genuinely ours is the policy: which paths, which domains, and what
happens when no boundary can be established. That part is specific to running
someone else's coding agent against your repository, and no general-purpose
sandbox can decide it for you.

## What holds today

Verified on a real machine, not asserted:

```
write inside the worktree      ALLOWED
write to ~/Desktop             DENIED
read ~/.ssh                    DENIED
read ~/.aws                    DENIED
```

## What does NOT hold

Stated here because a boundary people assume exists is worse than one they know
is missing.

- **Reads are open by default.** The profile is `(allow default)` plus targeted
  denials, so an agent can read anything outside `~/.ssh`, `~/.aws`, `~/.gnupg`
  and `~/.kube`. Deny-first is the intended direction; the obstacle is that a
  policy tight enough to break `npm install` gets switched off, which protects
  nothing.
- **The network is unbounded UNTIL a policy names allowed hosts.** The proxy
  exists (`network.go`) and is wired into both run paths, but an empty policy
  forwards everything — and nothing sets one yet. The Warden reports `network`
  as unheld until it does.
- **Even a set policy is not a cage.** Filtering happens at CONNECT, via
  `HTTPS_PROXY`, so an agent that ignores proxy environment variables reaches
  the network directly. On Linux a network namespace could close that; on macOS
  it cannot. This is a policy for well-behaved clients, and is described that
  way rather than as containment.
- **Windows has no mechanism.** `Detect()` returns `none`, and under the
  confinement-is-the-gate rule that means runs are refused rather than quietly
  downgraded.

## Rules that look arbitrary and are not

Each of these encodes a real failure. The next person to simplify one will
reintroduce the bug.

**Resolve every path first.** `sandbox-exec` matches on *resolved* paths, and
`/tmp` symlinks to `/private/tmp`. An unresolved path **fails open with no
error** — the way a confinement feature ships and protects nothing.

**Order matters in the profile.** Seatbelt is last-match-wins, so every deny
comes first and the workspace allow comes last. Written the other way round, the
deny on shared temp roots overrides the workspace itself whenever the workspace
lives under one — which it does for every Go test directory.

**Deny reads, not just writes.** With only `deny file-write*`,
`~/.ssh/id_ed25519` stays readable. Verified.

**Allow the toolchain caches.** npm, pip and cargo write to them constantly.
Denying them produces failures that look nothing like confinement, and the user
turns confinement off to make the agent work — the worst possible outcome.

**Reject paths containing `"` or `)`.** They break the s-expression, and a
profile that fails to parse is a profile that is not applied.
