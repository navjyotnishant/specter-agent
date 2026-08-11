# Specter Agent

Enterprise-grade agent orchestration for governed software delivery workflows.

Specter Agent helps teams design, operate, approve, and audit multi-agent
delivery workflows from a single workspace. Supervisors coordinate specialist
agents, approvals keep sensitive actions controlled, and run evidence remains
available for review.

📖 **Full documentation:** https://navjyotnishant.github.io/specter-agent/

## Install

One binary, no interpreter and no runtime dependency:

```bash
curl -fsSL https://raw.githubusercontent.com/navjyotnishant/specter-agent/main/install.sh | sh
```

The installer verifies the published SHA-256 checksum before putting anything on
your PATH, and refuses to install if it does not match. `SPECTER_INSTALL_DIR`
chooses where it lands; `SPECTER_VERSION` pins a release.

Then:

```bash
specter          # what this machine can do right now
specter serve    # the API and web UI
```

`git`, `gh` and the agent CLIs are **not** bundled — they carry your own
credentials. `specter status` reports which are missing and what each one
enables.

## Quickstart with Docker

```bash
mkdir -p data artifacts secrets codebases
docker compose up -d --build
```

See the [Local Operations guide](https://navjyotnishant.github.io/specter-agent/getting-started/local-operations)
for host prerequisites, volume mounts, and rebuild instructions.

## Documentation site development

The docs site lives in [docs/](docs/) as a separate Docusaurus project:

```bash
cd docs
npm install
npm start
```

See [AGENTS.md](AGENTS.md) for the full contributor/agent workflow.
