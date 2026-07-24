# Repository Guidelines

## Project Structure

- `packages/pet-agent/` contains the shared agent runtime, orchestrator, capability contracts, and examples.
- `services/local-agent/` contains the local CLI/TUI, local server, plugin loading, browser tools, and local config.
- `tools/agent-macos/` contains the macOS desktop companion.
- `docs/` contains public architecture and capability design notes.

## Commands

- `npm install` installs workspace dependencies.
- `npm run typecheck` checks the local agent TypeScript project.
- `npm test` runs pet-agent unit tests and local-agent unit tests.
- `npm run build` builds the local agent bundle.
- `cd services/local-agent && npm run tui` starts the local TUI.

## Style

- TypeScript uses 2-space indentation and semicolons.
- Prefer single quotes in TS/TSX imports and strings.
- Keep runtime-independent agent logic in `packages/pet-agent/`.
- Keep local machine, CLI, browser, and desktop integration in `services/local-agent/` or `tools/agent-macos/`.

## Documentation Workflow

- Treat ordinary documents under `docs/` as raw source material. Keep them updated
  alongside code when their design, behavior, or status changes.
- Do not treat normal development, documentation updates, or Wiki reads as an
  implicit Wiki ingest request.
- Do not update synthesized pages under `docs/wiki/` or append ingest records to
  `docs/log.md` unless the user explicitly asks to ingest or update the Wiki.
- When an architecture or design is still incomplete, record progress and open
  questions in the relevant raw document and defer Wiki ingest until the design is
  stable and the user explicitly requests it.

## Security

- Do not commit `.env`, tokens, JWTs, API keys, local session state, or generated build output.
- Keep private app/backend/Hasura code in the internal PinPawo repository.
