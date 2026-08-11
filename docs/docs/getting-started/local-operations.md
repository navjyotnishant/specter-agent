---
id: local-operations
title: Local Operations
sidebar_position: 2
---

# Local Operations

Runtime state lives under your home directory, **not** in the checkout, so
deleting the repository does not delete your run history or the key that
decrypts stored credentials:

| Host path | Container path | Purpose |
|---|---|---|
| `~/.specter/data` | `/app/data` | Database — workflows, runs, approvals, audit trail |
| `~/.specter/artifacts` | `/app/artifacts` | Generated reports and run artifacts |
| `~/.specter/secrets` | `/app/secrets` | Encryption key and runner token |
| `./codebases` | `/app/codebases` | Read-only mounted repositories for review |

`codebases` stays repo-relative because it holds the code being worked on rather
than application state.

`SPECTER_HOME` relocates the whole state directory. Both Docker and the CLI read
it, so they always resolve to the same place — set it for one and not the other
and they would read different databases.

## Checking prerequisites

```bash
specter status
```

It reports the agent CLIs on this machine, whether `git` and `gh` are present
and what each one enables, which confinement mechanism is active, the state
directory and database in use, and which repositories are approved.

It works before anything is configured — no database, no server, no container —
so it is the first thing to run when something is not working.

## Starting the app

```bash
docker compose up -d --build
```

Or without Docker, since the binary serves the web UI itself:

```bash
specter serve
```

Rebuilding is safe: state is outside the checkout and outside the image, so
`docker compose up -d --build` never touches it. To reset local state
deliberately, stop the app and remove the relevant files under `~/.specter`.

:::caution Migrating from an older install

State used to live in `./data`, `./artifacts` and `./secrets` inside the
checkout. To move an existing install:

```bash
docker compose down
mkdir -p ~/.specter
cp -a data artifacts secrets ~/.specter/
docker compose up -d --build
```

The key and the database must move **together**. `secrets/integration_secret.key`
decrypts the stored credentials in the database, and separating them makes every
stored credential unrecoverable — Fernet fails authentication, with no partial
recovery. Copy rather than move, and remove the originals only once the app has
started against the new location.

:::
