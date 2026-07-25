# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Workspaces

npm workspaces monorepo (Node.js >=24, validated on Node 24 and 26, ESM-only, TypeScript). Two published packages:

- `packages/pet-agent/` → `@pinpawo/pet-agent` — runtime-independent agent core: orchestrator graph, subagent, studio, capability registry, built-in tools. No CLI, no filesystem, no network beyond what LangChain models need.
- `services/local-agent/` → `pinpawo` (bin: `pinpawo`) — depends on pet-agent. Hosts the CLI/TUI (Ink/React), the local HTTP+WebSocket server (`localServer*`), capability/plugin loader for `~/.pinpawo/capabilities/`, local tool implementations (file/git/shell/network/search), browser tools, and the WS client that talks to the hosted PinPawo app.
- `tools/agent-macos/` — macOS desktop companion (not part of the npm workspaces root).

The architectural boundary is enforced by convention: anything that touches the machine (FS, shell, network, browser, ~/.pinpawo) belongs in `services/local-agent` or `tools/agent-macos`; anything reusable on a server belongs in `packages/pet-agent`.

## Wiki ingest

- Do not modify `docs/wiki/` or `docs/log.md` unless the user explicitly asks to ingest.
- During normal development, update raw documents under `docs/` instead. Keep incomplete designs there until ingest is explicitly requested.

## Commands

Run from repo root:

- `npm install` — install all workspaces.
- `npm run typecheck` — typecheck both packages.
- `npm test` — pet-agent tests (`node --test` on `src/agent/orchestrator/*.test.ts`, `src/agent/studio/*.test.ts`, `src/subagent/*.test.ts`, `src/tools/*.test.ts`) then local-agent `test:unit`.
- `npm run build` — tsup-bundles `pinpawo` into `services/local-agent/dist/` and generates manifest.

Per-workspace (use `-w <pkg>` or `cd`):

- Pet-agent single test file: `cd packages/pet-agent && node --import tsx/esm --test src/agent/orchestrator/route.test.ts`
- Local-agent single test file: `cd services/local-agent && node --import tsx --test src/cli.test.ts`
- Local-agent live test (hits real services): `cd services/local-agent && npm run test:live`
- TUI dev: `cd services/local-agent && npm run tui` (or `npm run tui:dry` for dry-run). `npm run login` first to set credentials.
- One-shot post: `npm run once` / `npm run once:dry`.
- Evals (pet-agent, needs `.env`): `npm run eval:route`, `eval:flow:mock-subagent`, `eval:hitl`, `eval:subagent`, `eval:dataset`.
- Eval (local-agent, needs `.env`): `npm run eval:hitl -w pinpawo` — drives `runChatSession` through a fake graph to verify structured-resume + shell authorization extras.

## Pet-agent architecture (where to look)

- `src/agent/createAgentRuntime.ts` + `src/agent/runAgent.ts` — entry points that wire a LangGraph runtime.
- `src/agent/orchestrator/` — the orchestrator graph: routing, HITL (human-in-the-loop), flow control. Tests next to source.
- `src/agent/studio/` — Studio orchestrator (multi-agent composition for the App Studio surface).
- `src/subagent/` — subagent execution (delegated tool-using sub-runs).
- `src/capabilities/` + `src/capability-registry.ts` — capability contract (manifest + tools/handlers). Capabilities are the unit of extensibility; orchestrator route is derived from them.
- `src/tools/` — built-in tool definitions shared with local-agent.
- See `docs/PET_AGENT_*` for design docs that explain orchestrator routing, capability runtime, studio composition, and the rewrite plan.

## Local-agent architecture

- `src/cli.ts` + `src/index.ts` — Commander CLI (`pinpawo login|actor|once|tui|capability ...`).
- `src/tui/` + `src/chatInterface.ts` — Ink/React TUI. State machine lives in `tuiStateReducer`; resume picker, transcript export, input/keys all have their own files with `.test.ts` siblings.
- `src/localServer.ts` + `src/localServer*.ts` + `src/localHttpHandlers.ts` + `src/localServerWsTransport.ts` — local HTTP+WS server on `127.0.0.1:3210`. Handles chat, studio reviews, TUI sessions, operation events. Macos companion and remote app talk to it; e.g. `GET /capabilities/rescan` reloads plugins.
- `src/localAgentAppWsClient.ts` + `src/localAgentAppChatHandler.ts` — WS client back to the hosted PinPawo app, plus its chat handler.
- `src/agentChannel.ts` / `src/agentGraphService.ts` / `src/agentStreamEvents.ts` — adapt pet-agent's LangGraph stream into channel events the TUI/server consume.
- `src/capabilityLoader.ts` + `src/pluginLoader.ts` + `src/localAgentCapabilityRegistry.ts` — load plugins from `~/.pinpawo/capabilities/<id>/` (each has `manifest.json` + `index.js`). `--link` install mode keeps a capability's own `node_modules` in place.
- `src/localTools*.ts` — local tool implementations (file/git/shell/network/search). Each has a unit test next to it. The shell/file/git tools are where the operation tracker (`toolOperationTracker.ts`, `runtimeOperationRegistry.ts`) sits.
- `src/config.ts` + `src/agentConfig.ts` + `src/llmConfig.ts` — config resolution. Reads `~/.pinpawo/config.json`, `~/.pinpawo/.env`, or process env. `.env.example` lives under `services/local-agent/`.
- `src/studio/` — local-side Studio integration (companion to pet-agent's `agent/studio`).

## Conventions

- ESM-only (`"type": "module"`), TypeScript with 2-space indent, semicolons, single quotes in imports/strings.
- Tests use `node --test` (no Jest/Vitest). Co-located `*.test.ts` next to source. Local-agent's `test:unit` only globs `src/*.test.ts` and `src/studio/*.test.ts` — tests in deeper subdirs won't run unless that glob is widened.
- `npm` overrides pin `langsmith` and `uuid` repo-wide; don't bump them in a workspace `package.json` without updating the root override.
- Keep runtime-independent logic in `packages/pet-agent/`; anything that opens a file, spawns a process, hits a port, or reads `~/.pinpawo` belongs in `services/local-agent/`.
- The private PinPawo app/backend/Hasura code lives in a separate internal repo — do not paste or assume it here.

## Capability plugins

User capability plugins live in `~/.pinpawo/capabilities/<id>/` and need `manifest.json` + `index.js`. Manage with `pinpawo capability validate|install|list` (`--link` for capabilities with their own deps). A running agent reloads them via `GET http://127.0.0.1:3210/capabilities/rescan`.
