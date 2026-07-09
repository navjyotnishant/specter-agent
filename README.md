# Specter Agent

Enterprise-grade agent orchestration for governed software delivery workflows.

Specter Agent helps teams design, operate, approve, and audit multi-agent
delivery workflows from a single workspace. Supervisors coordinate specialist
agents, approvals keep sensitive actions controlled, and run evidence remains
available for review.

📖 **Full documentation:** https://navjyotnishant.github.io/specter-agent/

## Quickstart

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
