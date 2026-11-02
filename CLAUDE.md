# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Workspaces

npm workspaces monorepo (Node.js >=24, validated on Node 24, ESM-only, TypeScript).

- `packages/pet-agent/` → `@pinpawo/pet-agent` — runtime-independent agent core: orchestrator graph, subagent, capability registry, built-in tools. No CLI, no filesystem, no network beyond what LangChain models need.
- `packages/studio/` → `@pinpawo/studio` — Studio Host/runtime library and the `pinpawo-studio` executable entry.
- `services/host/` → `pinpawo` (bin: `pinpawo`) — depends on pet-agent. Hosts the CLI and the OpenTUI client launcher, the local HTTP+WebSocket server (`server*.ts`), capability/plugin loader for `~/.pinpawo/capabilities/`, local tool implementations (file/git/shell/network/search), and browser tools.
- `services/tui/` → `@pinpawo/tui` — the OpenTUI (Bun-targeted) terminal client.
- `tests/agent-evals/` → `@pinpawo-tests/agent-evals` — repository-level Agent evals (real-model and scripted). Depends on both pet-agent and the Host so that pet-agent itself never imports Host code; eval scripts read `tests/agent-evals/.env`.

The architectural boundary is enforced by convention: anything that touches the machine (FS, shell, network, browser, ~/.pinpawo) belongs in `services/host`; anything reusable on a server belongs in `packages/pet-agent`.

## Wiki ingest

- The synthesized wiki under `docs/wiki/` was removed as unmaintained; do not recreate it in normal development. Do not modify `docs/log.md` unless the user explicitly asks to ingest.
- During normal development, update raw documents under `docs/` instead. Keep incomplete designs there until ingest is explicitly requested.

## Commands

Run from repo root:

- `npm install` — install all workspaces.
- `npm run typecheck` — typecheck every workspace.
- `npm test` — runs every workspace's tests in turn (agent-contracts, pet-agent, studio, agent-session, tui, browser toolkit, the six plugins: channel, scheduler, notice, trigger, project-files, studio-http; then studio-e2e and agent-evals) and ends with host `test:unit`.
- `npm run build` — builds every workspace in dependency order: `agent-contracts` → `agent-session` → `pet-agent` → `pinpawo` (Host) → `studio-core` → the six Plugins → `studio` → `studio-console`. Host's own `build` runs `tsup` (bundling `pinpawo` into `services/host/dist/` and generating its manifest) plus the TUI distribution build.

Per-workspace (use `-w <pkg>` or `cd`):

- Host live test (hits real services): `cd services/host && npm run test:live`
- TUI dev: `cd services/host && npm run tui`.

## Conventions

- ESM-only (`"type": "module"`), TypeScript with 2-space indent, semicolons, single quotes in imports/strings.
- Tests use `node --test` (no Jest/Vitest). Co-located `*.test.ts` next to source. Host's `test:unit` finds every `src/**/*.test.ts`, so tests in subdirectories do run.
- `npm` overrides pin `langsmith` and `uuid` repo-wide; don't bump them in a workspace `package.json` without updating the root override.

## Tool operation summaries

Toolkit `summarize` output uses only the generic block kinds in `@pinpawo/agent-contracts`. Adding a block kind follows the fixed process in `docs/design/host/operation-summary.md` §3: one PR updating the contracts type, validation and default text rendering (`operationBlockToText`, whose switch must stay exhaustive) plus at least one toolkit using it; clients render blocks only through `renderOperationBlock` with a partial renderer map, so native rendering is optional and any kind without a renderer (including newer ones) falls back to the default text.

## Capability plugins

Chat Capability definitions live in `~/.pinpawo/capabilities/<id>/CAPABILITY.md`; an optional `index.js` may only export the documented lifecycle hook. Definitions are loaded when the Chat Host starts. Studio Pet definitions use their conventional per-Pet directories instead of this global source.
