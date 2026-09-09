# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Workspaces

npm workspaces monorepo (Node.js >=24, validated on Node 24 and 26, ESM-only, TypeScript).

- `packages/pet-agent/` → `@pinpawo/pet-agent` — runtime-independent agent core: orchestrator graph, subagent, studio, capability registry, built-in tools. No CLI, no filesystem, no network beyond what LangChain models need.
- `services/local-agent/` → `pinpawo` (bin: `pinpawo`) — depends on pet-agent. Hosts the CLI/TUI (Ink/React), the local HTTP+WebSocket server (`server*.ts`), capability/plugin loader for `~/.pinpawo/capabilities/`, local tool implementations (file/git/shell/network/search), and browser tools.
- `tools/agent-macos/` — macOS desktop companion (not part of the npm workspaces root).

The architectural boundary is enforced by convention: anything that touches the machine (FS, shell, network, browser, ~/.pinpawo) belongs in `services/local-agent` or `tools/agent-macos`; anything reusable on a server belongs in `packages/pet-agent`.

## Wiki ingest

- Do not modify `docs/wiki/` or `docs/log.md` unless the user explicitly asks to ingest.
- During normal development, update raw documents under `docs/` instead. Keep incomplete designs there until ingest is explicitly requested.

## Commands

Run from repo root:

- `npm install` — install all workspaces.
- `npm run typecheck` — typecheck every workspace.
- `npm test` — runs every workspace's tests in turn (agent-contracts, pet-agent, studio, agent-session, tui, browser toolkit, the five plugins, studio-e2e) and ends with local-agent `test:unit`.
- `npm run build` — tsup-bundles `pinpawo` into `services/local-agent/dist/` and generates manifest.

Per-workspace (use `-w <pkg>` or `cd`):

- Local-agent live test (hits real services): `cd services/local-agent && npm run test:live`
- TUI dev: `cd services/local-agent && npm run tui`.

## Conventions

- ESM-only (`"type": "module"`), TypeScript with 2-space indent, semicolons, single quotes in imports/strings.
- Tests use `node --test` (no Jest/Vitest). Co-located `*.test.ts` next to source. Local-agent's `test:unit` finds every `src/**/*.test.ts`, so tests in subdirectories do run.
- `npm` overrides pin `langsmith` and `uuid` repo-wide; don't bump them in a workspace `package.json` without updating the root override.

## Capability plugins

Chat Capability definitions live in `~/.pinpawo/capabilities/<id>/CAPABILITY.md`; an optional `index.js` may only export the documented lifecycle hook. Definitions are loaded when the Chat Host starts. Studio Pet definitions use their conventional per-Pet directories instead of this global source.
