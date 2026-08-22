# Repository Guidelines

## Project Structure

- `packages/pet-agent/` contains the shared agent runtime, orchestrator, capability contracts, and examples.
- `services/local-agent/` contains the local CLI/TUI, local server, plugin loading, browser tools, and local config.
- `tools/agent-macos/` contains the macOS desktop companion.
- `docs/` contains public architecture and capability design notes.

## macOS Companion Status

- All functionality under `tools/agent-macos/` is suspended until the user explicitly reactivates it.
- Do not treat the macOS companion as an active consumer, compatibility constraint, migration target, or acceptance-test scope for feature work and architectural refactors.
- Refactors may change or remove interfaces used by the macOS companion without preserving or updating its integration. Do not proactively modify or test macOS companion code unless the user explicitly requests it.

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

## Design Draft Lifecycle

- When a change introduces a coherent subsystem concept or cross-cutting contract, create or update a draft design under `docs/` before or alongside broad implementation work.
- Keep the draft aligned as implementation and review change the concept. Do not let later PRs silently diverge from its boundaries, open questions, or migration plan.
- A draft is working design evidence, not a canonical contract. Promote it to a formal document only after the concept and implementation have stabilized and received explicit review.
- Small, isolated fixes do not require a new design draft. Prefer updating an existing draft over creating a competing document for the same concept.

## Security

- Do not commit `.env`, tokens, JWTs, API keys, local session state, or generated build output.
- Keep private app/backend/Hasura code in the internal PinPawo repository.
