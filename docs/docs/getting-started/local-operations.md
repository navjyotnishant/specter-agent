---
id: local-operations
title: Local Operations
sidebar_position: 2
---

# Local Operations

Runtime state is host-mounted so rebuilding or recreating the app does not wipe
local work:

| Host path | Container path | Purpose |
|---|---|---|
| `./data` | `/app/data` | Application data |
| `./artifacts` | `/app/artifacts` | Generated reports and run artifacts |
| `./secrets` | `/app/secrets` | Local secret/config files |
| `./codebases` | `/app/codebases` | Read-only mounted repositories for review |

Before starting Specter Agent, check the host prerequisites:

```bash
python3 scripts/check_prerequisites.py
```

The checker reports missing Docker, Docker Compose, Docker Sandboxes, daemon,
authentication, and host-runner prerequisites with exact remediation commands.
Use JSON output when another installer or app flow needs to consume the result:

```bash
python3 scripts/check_prerequisites.py --json
```

Start the app with:

```bash
mkdir -p data artifacts secrets codebases
docker compose up -d --build
```

You can rebuild safely with `docker compose up -d --build`; application data
remains under `./data`. To intentionally reset local state, stop the app and
delete the relevant host files.
