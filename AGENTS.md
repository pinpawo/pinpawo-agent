# Repository Guidelines

## Project Structure

- `packages/pet-agent/` contains the runtime-independent agent orchestration.
- `packages/studio/` contains the independent Studio Host/runtime contracts and CLI.
- `plugins/` contains optional concrete Studio Plugins; Studio must not import them.
- `services/host/` contains the local CLI, server, runtime composition, and config.
- `tests/studio-e2e/` contains cross-package Studio acceptance tests; concrete Plugins must remain independent of each other.
- `toolkits/` contains concrete Agent Toolkits and Toolkit-owned runtimes; `services/tui/` contains the terminal client.
- `docs/` contains public architecture and capability design notes.

Machine integration belongs in `services/` and `toolkits/`, outside the agent core.

## Commands

- `npm install` installs workspace dependencies.
- `npm run typecheck` checks workspace TypeScript projects and runs Host unit tests.
- `npm test` runs workspace tests, including Studio acceptance tests and agent evals.
- `npm run build` builds the workspace packages, Plugins, Host, and Studio Console.
- `cd services/host && npm run tui` starts the local TUI.

## Style

- TypeScript uses 2-space indentation and semicolons.
- Prefer single quotes in TS/TSX imports and strings.

## Testing

- Do not add tests that only compare prompt prose with literal strings or regular expressions. Prompt wording is not a stable unit-test contract.
- Test prompt-related changes through observable behavior, structured schemas, dynamic data boundaries, or dedicated model evaluations instead.

## Wiki Ingest

- Do not modify `docs/wiki/` or `docs/log.md` unless the user explicitly asks to ingest.
- For documentation evidence and ingest rules, see [docs/AGENTS.md](docs/AGENTS.md).

## Design Drafts

Keep subsystem and cross-cutting design drafts under `docs/` aligned with implementation.
Drafts are working evidence; formal promotion requires stable concepts and implementation plus explicit review. Small fixes need no new draft.

## Security

- Do not commit `.env`, tokens, JWTs, API keys, local session state, or generated build output.
- Keep private app/backend/Hasura code in the internal PinPawo repository.
