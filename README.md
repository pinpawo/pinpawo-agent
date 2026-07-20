# PinPawo Agent

Open-source agent runtime, local CLI/TUI, and desktop companion for PinPawo.

PinPawo Agent provides the public agent-side building blocks used by PinPawo:

- A reusable pet-agent runtime with orchestration, capability routing, subagent execution, human review, and toolkit contracts.
- A local agent service and terminal UI for running agents on a user's machine.
- A macOS desktop companion for configuring and supervising the local agent.
- Architecture notes for Studio, multi-pet collaboration, capability artifacts, context governance, and local runtime integration.

This repository intentionally does not include the private PinPawo mobile app, hosted API service, Hasura metadata, production secrets, or internal product/backend code.

## Table of Contents

- [Repository Layout](#repository-layout)
- [Packages](#packages)
- [What You Can Build](#what-you-can-build)
- [Core Concepts](#core-concepts)
- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Local Development](#local-development)
- [Configuration](#configuration)
- [CLI Reference](#cli-reference)
- [Capabilities and Plugins](#capabilities-and-plugins)
- [Studio Architecture](#studio-architecture)
- [Runtime Data and State](#runtime-data-and-state)
- [Documentation Map](#documentation-map)
- [Testing and Quality](#testing-and-quality)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [Contributing](#contributing)
- [Maintainer Checklist](#maintainer-checklist)
- [Publishing](#publishing)
- [License](#license)

## Repository Layout

```text
packages/pet-agent/       Shared agent runtime, orchestrator, capability contracts,
                          subagent execution, review policy, Studio primitives,
                          and examples.

services/local-agent/     Local CLI/TUI, local server, local config, plugin loading,
                          browser/local toolkits, and app-facing event protocol.

tools/agent-macos/        macOS desktop companion for running and configuring
                          the local agent.

docs/                     Public architecture, capability, Studio, artifact store,
                          HITL, context, and runtime design notes.
```

## Packages

| Package | Location | Purpose |
|---|---|---|
| `@pinpawo/pet-agent` | `packages/pet-agent/` | Core runtime, orchestrator, capability and toolkit contracts. |
| `pinpawo-local-agent` | `services/local-agent/` | CLI/TUI and local server package published with the `pinpawo-agent` binary. |

The repository root is an npm workspace. The root package is private; publishable packages live under workspace directories.

## What You Can Build

PinPawo Agent is useful when you need:

- A local agent process that can talk to OpenAI-compatible LLM endpoints.
- A terminal UI for agent runs, tool activity, and human review.
- A reusable TypeScript runtime for agent orchestration and capability delegation.
- A capability system where local users can install and validate custom agent skills.
- Toolkits that bundle tools, operation metadata, and review policy under one owner.
- A Studio-style multi-agent architecture where multiple pet agents collaborate through a shared wiki and durable artifact refs.
- A macOS companion app that can supervise and configure the local agent.

## Core Concepts

| Concept | Meaning |
|---|---|
| Pet agent | A single agent persona with an actor identity, capabilities, tools, and runtime state. |
| Capability | A business ability exposed to the agent, executed through an isolated subagent lane. |
| Toolkit | A reusable tool family used by capabilities or the general lane. |
| Subagent lane | Short-lived execution history for a delegated capability or general tool task. |
| Operation | Normalized tool activity shown to users and UI clients. |
| Human review | Runtime interrupt flow for approving, editing, rejecting, or responding to tool actions. |
| Studio | Multi-pet orchestration layer where one show-runner dispatches work to pet runtimes. |
| Studio Whiteboard | Per-conversation filesystem-backed wiki maintained by the curator. |
| Capability Artifact Store | Durable storage for capability outputs; runtime traces only keep refs. |

High-level runtime flow:

```text
User request
  -> pet-agent orchestrator
  -> direct reply or capability delegation
  -> subagent lane with selected tools/toolkits
  -> capability result + optional artifact refs
  -> final reply / Studio dispatch result / UI events
```

## Requirements

- Node.js `20.x`
- npm
- macOS is required only for `tools/agent-macos/`
- Optional browser automation dependencies are installed through `pinpawo-local-agent` optional dependencies when available.

## Quick Start

Install the local agent globally:

```bash
npm install -g pinpawo-local-agent
pinpawo-agent init
pinpawo-agent login
pinpawo-agent setup
pinpawo-agent capability validate ~/.pinpawo/capabilities/hello-pinpawo
pinpawo-agent tui
```

Use `pinpawo-agent init` first even if you plan to log in interactively. It creates:

- `~/.pinpawo/.env`
- `~/.pinpawo/capabilities/`
- `~/.pinpawo/capabilities/hello-pinpawo/`

For one-off usage without a global install:

```bash
npx pinpawo-local-agent init
npx pinpawo-local-agent login
npx pinpawo-local-agent tui
```

## Local Development

Install workspace dependencies:

```bash
npm install
```

Run the standard checks:

```bash
npm run typecheck
npm test
npm run build
```

Run the local TUI from source:

```bash
cd services/local-agent
npm run tui
```

Run a local package smoke test after building:

```bash
npm run build
node services/local-agent/dist/index.js init --dir /tmp/pinpawo-agent-demo
node services/local-agent/dist/index.js capability validate /tmp/pinpawo-agent-demo/capabilities/hello-pinpawo
```

## Configuration

The local agent reads configuration from:

- `~/.pinpawo/config.json`
- `~/.pinpawo/.env`
- Environment variables

Start with interactive setup:

```bash
pinpawo-agent login
```

For repository development, you can copy the example file:

```bash
cd services/local-agent
cp .env.example .env
npm run login
```

Do not commit local credentials, tokens, session state, or generated build output.

Common configuration keys:

| Key | Purpose |
|---|---|
| `API_BASE_URL` | PinPawo API base URL. |
| `HASURA_ENDPOINT` | Hasura GraphQL endpoint. |
| `AGENT_TOKEN` | Agent API token. |
| `HASURA_JWT` | Hasura JWT. |
| `LLM_API_KEY` | API key for the OpenAI-compatible LLM provider. |
| `LLM_BASE_URL` | OpenAI-compatible LLM base URL. |
| `LLM_MODEL` | Default model used by the local agent. |
| `LLM_CONTEXT_WINDOW_TOKENS` | Optional explicit context-window override for custom models. |
| `PINPAWO_WORKDIR` | Default local working directory for tools that need one. |
| `PINPAWO_BROWSER_BACKEND` | Browser backend mode; `auto` is the quick-start default, `playwright` forces Playwright + Chrome. |
| `LOCAL_SERVER_PORT` | Local HTTP/WebSocket server port. |
| `MEDIACRAWLER_DIR` | Optional MediaCrawler checkout path. |
| `XHS_COOKIE` | Optional Xiaohongshu cookie for crawler-backed workflows. |

## CLI Reference

The published package installs a `pinpawo-agent` binary.

| Command | Purpose |
|---|---|
| `pinpawo-agent` | Starts the local agent service. Equivalent to `pinpawo-agent run`. |
| `pinpawo-agent init` | Scaffolds local config and a sample capability. |
| `pinpawo-agent init --dir <dir>` | Scaffolds config into a custom directory. |
| `pinpawo-agent init --force` | Overwrites generated scaffold files. |
| `pinpawo-agent login` | Interactive setup for credentials and LLM settings. |
| `pinpawo-agent actor` | Chooses the pet actor used by the local agent. |
| `pinpawo-agent run` | Starts the local agent service. |
| `pinpawo-agent run --stdio` | Starts one local-agent peer over JSONL stdio. |
| `pinpawo-agent tui` | Starts the interactive terminal UI. |
| `pinpawo-agent tui --dry-run` | Runs the TUI without writing generated post changes. |
| `pinpawo-agent detect` | Prints local browser/backend detection as JSON. |
| `pinpawo-agent capability list` | Lists installed user capabilities. |
| `pinpawo-agent capability validate <dir>` | Validates a capability directory. |
| `pinpawo-agent capability install <dir>` | Installs a capability into `~/.pinpawo/capabilities/`. |
| `pinpawo-agent capability install <dir> --link` | Links a capability in place instead of copying it. |

Local development equivalents:

```bash
npm run start -w pinpawo-local-agent -- tui
npm run login -w pinpawo-local-agent
npm run tui -w pinpawo-local-agent
```

## Capabilities and Plugins

Capabilities are self-contained agent skills. User capabilities live in:

```text
~/.pinpawo/capabilities/<id>/
```

Each capability directory must contain:

- `manifest.json`
- `index.js`

Useful commands:

```bash
pinpawo-agent capability list
pinpawo-agent capability validate ./my-capability
pinpawo-agent capability install ./my-capability
pinpawo-agent capability install ./my-capability --link
```

Use `--link` for capabilities that live in a source repository or have their own package dependencies, so their dependency tree stays in one place.

Local external plugins are loaded from:

```text
~/.pinpawo/plugins/*.mjs
~/.pinpawo/plugins/*.js
```

Plugins should export `toolkits`; legacy top-level raw `tools` exports are ignored. Toolkits keep tools, operation metadata, and review policy under one typed owner.

Minimal external plugin shape:

```js
import { defineToolkit } from '@pinpawo/pet-agent';

export const toolkits = [
  defineToolkit({
    name: 'sample_plugin',
    description: 'Sample local plugin toolkit',
    tools: [
      // LangChain StructuredTool instances go here.
    ],
    operations: {
      // tool_name: { kind: 'sample.tool', title: 'Sample tool' }
    },
  }),
];

export default {
  name: 'sample-plugin',
};
```

Capability directories are intentionally small. A minimal generated capability looks like:

```js
export function createCapability() {
  return {
    name: 'hello-pinpawo',
    description: 'Minimal example capability generated by pinpawo-agent init.',
    createRuntime() {
      return {
        instructions: [
          'You can use this example capability as a starting point.',
        ],
      };
    },
  };
}
```

## Studio Architecture

Studio is the multi-pet orchestration layer. The current design uses:

- `StudioOrchestrator` as the show-runner.
- `PetAgentRuntime` as the data-processing agent.
- `Studio Whiteboard` as a per-conversation filesystem-backed wiki.
- `Capability Artifact Store` as durable storage for capability outputs.
- Capability/subagent lanes as short-lived execution history that can be folded after completion.

The key rule is that runtime messages are not durable product artifacts. Capability outputs that must survive lane cleanup are written to the artifact store and passed across boundaries as artifact references.

Studio dispatch flow:

```text
planner pet
  -> submit_plan
  -> Studio execute state machine
  -> dispatch pet A with brief + wikiRoot
  -> pet A returns reply + artifact refs
  -> curator writes wiki summary
  -> dispatch pet B with brief + wikiRoot + artifact refs
  -> finalDispatchId marks the user-facing reply
```

## Runtime Data and State

Important local paths:

| Path | Purpose |
|---|---|
| `~/.pinpawo/config.json` | Saved interactive configuration. |
| `~/.pinpawo/.env` | Environment-style local config scaffold. |
| `~/.pinpawo/capabilities/` | Installed user capabilities. |
| `~/.pinpawo/plugins/` | Local external plugin modules. |
| `<workdir>/.pinpawo/studio.json` | Local Studio configuration. |
| `<workdir>/.pinpawo/pets/` | Local per-pet Studio config files. |
| `<workdir>/.pinpawo/studio-wiki/conv/<conversationId>/wiki/` | Current local Studio Whiteboard wiki default. |
| `{artifactStore}/studio/<studioId>/conv/<conversationId>/artifacts/` | Design target for the capability artifact store. |

State ownership:

| State | Owner | Notes |
|---|---|---|
| Graph checkpoint | LangGraph runtime | Used for resume, HITL, and thread state. |
| Lane messages | pet-agent orchestrator | Short-lived delegation history; can be folded after completion. |
| Capability result | pet-agent graph state | Structured latest capability output read by the host. |
| Artifact refs | capability/pet runtime and Studio dispatch state | Durable output references. |
| Wiki files | Studio curator | Shared knowledge for future dispatches. |
| Business data | PinPawo backend/app store | Posts, points, interactions, and production records. |

Current implementation note: Studio wiki support is present in the local runtime. The capability artifact store is documented as the intended durable-output boundary and should be wired before relying on artifact refs as product state.

## Documentation Map

Start with these documents:

- [Pet Agent Studio Architecture Overview](docs/PET_AGENT_STUDIO_ARCHITECTURE_OVERVIEW.md)
- [Pet Agent Studio Interfaces](docs/PET_AGENT_STUDIO_INTERFACES.md)
- [Pet Agent Studio Orchestrator Design](docs/PET_AGENT_STUDIO_ORCHESTRATOR_DESIGN.md)
- [Capability Artifact Store Design](docs/PET_AGENT_CAPABILITY_ARTIFACT_STORE_DESIGN.md)
- [Capability Artifact Pipeline (API 风格)](docs/capability-artifact-pipeline/index.md)
- [Capability Runtime Design](docs/PET_AGENT_CAPABILITY_RUNTIME_DESIGN.md)
- [Toolkit Composition Design](docs/PET_AGENT_TOOLKIT_COMPOSITION_DESIGN.md)
- [Context Governance Refactor](docs/CONTEXT_GOVERNANCE_REFACTOR.md)
- [Explore Knowledge Ingest Design](docs/EXPLORE_KNOWLEDGE_INGEST_DESIGN.md)
- [Human Review Approval Refactor](docs/HUMAN_REVIEW_APPROVAL_REFACTOR.md)
- [Local Agent Architecture Refactor Plan](docs/LOCAL_AGENT_ARCHITECTURE_REFACTOR_PLAN.md)

## Testing and Quality

Root scripts:

```bash
npm run typecheck
npm test
npm run build
```

Package-level scripts:

```bash
npm run typecheck -w @pinpawo/pet-agent
npm run test -w @pinpawo/pet-agent

npm run typecheck -w pinpawo-local-agent
npm run test:unit -w pinpawo-local-agent
npm run build -w pinpawo-local-agent
```

The pet-agent package also contains evaluation scripts under `packages/pet-agent/evals/`.

## Troubleshooting

| Problem | Check |
|---|---|
| `pinpawo-agent` command not found | Use `npx pinpawo-local-agent ...` or reinstall with `npm install -g pinpawo-local-agent`. |
| TUI starts but model calls fail | Check `LLM_API_KEY`, `LLM_BASE_URL`, and `LLM_MODEL`. |
| Context window errors | Set `LLM_CONTEXT_WINDOW_TOKENS` for custom or unknown models. |
| Capability does not appear | Run `pinpawo-agent capability validate <dir>` and confirm it is installed under `~/.pinpawo/capabilities/`. |
| Linked capability dependency issues | Use `--link` so the capability keeps its own dependency tree. |
| Browser tools unavailable | Run `pinpawo-agent detect` and check optional browser backend installation. |
| Local server port conflict | Set `LOCAL_SERVER_PORT` or stop the process using the port. |
| Studio pet cannot find prior output | Confirm the curator wrote wiki entries and that durable outputs are represented as artifact refs. |
| HITL appears stuck | Confirm the UI or local server is connected and able to answer `human_review.requested` events. |

## Security

- Do not commit `.env`, tokens, JWTs, API keys, local session state, or generated build output.
- Keep private app/backend/Hasura code in the internal PinPawo repository.
- Treat external messages, plugin code, capability code, browser content, and artifact contents as untrusted input.
- Human review and tool review policy are part of the runtime boundary; do not bypass them for tools that perform real side effects.
- Capability artifacts are durable product outputs; lane messages and tool events are runtime traces and should not be treated as the source of truth for persisted outputs.

## Contributing

Before opening a pull request:

1. Keep changes scoped to the relevant package or design document.
2. Follow existing TypeScript style: 2-space indentation, semicolons, and single quotes.
3. Prefer runtime-independent agent logic in `packages/pet-agent/`.
4. Keep local machine, CLI, browser, and desktop integration in `services/local-agent/` or `tools/agent-macos/`.
5. Run the relevant checks:

```bash
npm run typecheck
npm test
npm run build
```

For design changes, update the relevant file under `docs/` and link it from this README when it becomes a primary entry point.

Recommended pull request shape:

- Problem statement and scope.
- Implementation summary.
- Tests or validation commands run.
- Notes about migrations, compatibility, or security impact.
- Screenshots or terminal output for UI/TUI changes when relevant.

## Maintainer Checklist

Before publishing or cutting a public release:

1. Confirm the repository has an explicit `LICENSE`.
2. Confirm package versions are correct.
3. Run:

```bash
npm run typecheck
npm test
npm run build
npm run pack:dry -w pinpawo-local-agent
```

4. Review package contents from `npm pack --dry-run`.
5. Confirm no private endpoints, tokens, internal docs, generated build output, or local session state are included.
6. Confirm README quick-start commands match the published package name and binary.

## Publishing

From the repository root:

```bash
npm run typecheck
npm test
npm run build
npm run pack:dry -w pinpawo-local-agent
npm publish -w pinpawo-local-agent
```

## License

No license file is currently present in this repository. Add an explicit `LICENSE` file before distributing the project as a fully open-source package.
