# PinPawo Agent

Open-source agent components for PinPawo.

## Repository Structure

- `packages/pet-agent/` - shared agent runtime, orchestrator, capability contracts, and built-in capabilities.
- `services/local-agent/` - local CLI/TUI agent client, local server, browser/tools integration, and plugin loading.
- `tools/agent-macos/` - macOS desktop companion for running and configuring the local agent.
- `docs/` - public agent architecture, capability, Studio, and runtime notes.

The private PinPawo app/backend repository keeps the mobile app, hosted API, Hasura metadata, product logic, and internal docs.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

Local agent configuration is read from `~/.pinpawo/config.json`, `~/.pinpawo/.env`, or environment variables. Start with:

```bash
cd services/local-agent
cp .env.example .env
npm run login
npm run tui
```

## Packages

- `@pinpawo/pet-agent`
- `pinpawo-local-agent`

## User Capabilities

User capability plugins live in `~/.pinpawo/capabilities/<id>/` and must contain `manifest.json` plus `index.js`.

```bash
pinpawo-agent capability validate ./my-capability
pinpawo-agent capability install ./my-capability
pinpawo-agent capability install ./my-capability --link
pinpawo-agent capability list
```

Use `--link` for capabilities that live in a source repo or have their own package dependencies, so their dependency tree stays in one place. A running local agent can reload installed plugins via `GET http://127.0.0.1:3210/capabilities/rescan`; the macOS settings pane calls this when Agent is running.

## Notes

This repository intentionally does not include the PinPawo mobile app, hosted API service, Hasura metadata, production secrets, or internal onboarding docs.
