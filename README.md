# Specter Agent

Governed multi-agent delivery workflows — design, run, approve, and audit agent
runs from one workspace.

Supervisors coordinate specialist agents, approval gates hold sensitive actions
until a human resolves them, and every run leaves evidence behind. Agents run on
your machine, with your own CLIs and your own credentials — and confined, so a
bad prompt costs a discarded directory rather than your work.

📖 **Full documentation:** https://navjyotnishant.github.io/specter-agent/

## Install

One binary. No interpreter, no virtualenv, no package manager.

```bash
curl -fsSL https://raw.githubusercontent.com/navjyotnishant/specter-agent/main/install.sh | sh
```

The installer verifies the published SHA-256 before putting anything on your
PATH, and refuses to install if it does not match. `SPECTER_INSTALL_DIR` chooses
where it lands; `SPECTER_VERSION` pins a release.

```bash
specter                       # what this machine can do right now
specter serve                 # the API and web UI
specter run <workflow>        # run one here, no server needed
specter models                # what each installed agent can run
```

`git`, `gh` and the agent CLIs are **not** bundled — they carry your own
credentials, and bundling them would be wrong even if it were possible.
`specter status` reports which are missing and what each one costs you.

## The Warden

What stands between an agent and the rest of your machine. `specter status`
reports every layer, including any that do not hold:

```
  warden  what stands between an agent and your machine
    ✓ filesystem   sandbox-exec — writes confined to the worktree
    ✓ credentials  ~/.ssh, ~/.aws, ~/.gnupg, ~/.kube unreadable
    ✓ reads        confined to the worktree; $HOME denied except toolchain paths
    ✓ network      30 host pattern(s) allowed, via proxy
```

Every run gets its own `git worktree` under `~/.specter`, and the agent is
confined there — **your checkout is never handed to an agent**. Writes outside
it are denied by the OS, not by the agent's own permission flag, which is
advisory and can be shelled past.

The network default was built by watching what a real agent reaches: its model
API, its MCP endpoints, and package registries. Telemetry sinks were observed
too and deliberately left out. Extend it per run or per node:

```bash
specter run <workflow> --allow-host internal.registry,*.example.com
specter run <workflow> --deny-host telemetry.vendor.com
```

Read-only unless you ask otherwise. A `--write` run arrives as a pull request,
never as edits already in your branch.

Details, including what the Warden does **not** cover:
[internal/isolation](internal/isolation/README.md).

## Running in Docker

The app can stay contained while agents run on your host — which is the point,
since a container has neither your agent CLIs nor your credentials:

```bash
specter agent-host            # on your machine: spawns agents, confined
docker compose up -d --build  # the app: API and web UI
```

State lives in `~/.specter`, not in the checkout, so deleting the repository
does not delete your run history or the key that decrypts stored credentials.

See the [Local Operations guide](https://navjyotnishant.github.io/specter-agent/getting-started/local-operations)
for mounts, migration from an older install, and rebuild instructions.

## Contributing

```bash
go build ./... && go test ./...     # backend
npm run build                       # frontend
cd docs && npm start                # the documentation site
```

See [AGENTS.md](AGENTS.md) for the full contributor and agent workflow.
