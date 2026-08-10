# End-to-end tests

These build the real binary, run it, and talk to it over HTTP the way the
frontend does.

```bash
go test ./test/e2e/            # ~40s
go test ./...                  # everything, including package tests
```

## Why these exist separately from the package tests

`internal/api` tests call `NewRouter()` in-process. That is fast, and it caught
a great deal. But **every bug that reached a browser during the Go port escaped
it**:

| Bug | Why the package tests missed it |
|---|---|
| CORS was missing entirely | `curl` does not enforce CORS. All 94 endpoints returned 200 while the app could not load a single request. |
| `--addr` swallowed `--db` | Argument parsing happens before any handler exists. The server tried to listen on an address called `--db`. |
| `sbx --version` | That flag does not exist. The CLI answers `ERROR: unknown flag`, which was read and reported as a version string. |
| `node.Runtime()` used as an agent name | Only a real run against a real machine produced `no agent CLI found for direct`. |
| A timeout could hang forever | A killed process whose grandchild held the output pipe. Visible only with a real subprocess. |

The pattern is consistent: anything that only fails through the **real
transport**, the **real argument parser**, or the **real filesystem** belongs
here.

## What is covered

**`e2e_test.go`** — the server. Flag ordering, browser preflight, every endpoint
the UI calls on load, the setup flow, the workspace allowlist boundary
(including `/etc`), unauthenticated access to all the routes that were open in
Python (issue #40), and clean shutdown on SIGINT.

**`cli_test.go`** — the binary's other half. `specter serve` and `specter run`
are the same artifact with different entry points, and the CLI's failure modes
are its own: argument parsing, exit codes, and what a human reads on a terminal.
An unknown command must not exit 0, or a script treats a typo as success.

## Conventions

- Each test gets its **own server and its own database** in a temp directory.
  Nothing shares state, so tests can run in any order.
- A free port is chosen per server, so a parallel run does not collide.
- Building the binary is a **skip**, not a failure — these should not break a
  test run on a machine without a Go toolchain configured for it.
- Server output goes to a log file that is printed if startup fails, because
  "the server never became healthy" is useless without knowing why.
