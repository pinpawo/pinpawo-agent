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

## Testing

- Do not add tests that only compare prompt prose with literal strings or regular expressions. Prompt wording is not a stable unit-test contract.
- Test prompt-related changes through observable behavior, structured schemas, dynamic data boundaries, or dedicated model evaluations instead.

## Wiki Ingest

- Do not modify `docs/wiki/` or `docs/log.md` unless the user explicitly asks to ingest.
- During normal development, update raw documents under `docs/` instead. Keep incomplete designs there until ingest is explicitly requested.

## Security

- Do not commit `.env`, tokens, JWTs, API keys, local session state, or generated build output.
- Keep private app/backend/Hasura code in the internal PinPawo repository.
