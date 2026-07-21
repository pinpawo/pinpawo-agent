# PinPawo Local Agent

Local CLI/TUI agent client for PinPawo.

## Quick Install

Requires Node.js 20.x.

```bash
npm install -g pinpawo-local-agent
pinpawo-agent init
pinpawo-agent login
pinpawo-agent setup
pinpawo-agent capability validate ~/.pinpawo/capabilities/hello-pinpawo
pinpawo-agent tui
```

For one-off usage without a global install:

```bash
npx pinpawo-local-agent init
npx pinpawo-local-agent login
npx pinpawo-local-agent tui
```

`pinpawo-agent init` creates the quick-start scaffold:

- `~/.pinpawo/.env` with all supported environment keys.
- `~/.pinpawo/capabilities/` for user capabilities.
- `~/.pinpawo/capabilities/hello-pinpawo/` as a minimal capability that validates and loads.

Configuration is read from `~/.pinpawo/config.json`, `~/.pinpawo/.env`, and environment variables. Use `pinpawo-agent login` for interactive credential setup, `pinpawo-agent setup` to check missing config and next steps, or edit `~/.pinpawo/.env` directly. Set `PINPAWO_LOCAL_ONLY=1` to start without hosted API, WebSocket relay, or Hasura GraphQL connections even when saved server credentials exist. Browser automation defaults to Playwright detection; the opt-in Chrome extension backend is selected with `PINPAWO_BROWSER_BACKEND=extension`.

For a local repository smoke test:

```bash
npm install
npm run build
node services/local-agent/dist/index.js init --dir /tmp/pinpawo-agent-demo
node services/local-agent/dist/index.js capability validate /tmp/pinpawo-agent-demo/capabilities/hello-pinpawo
```

## External Plugins

Local external plugins are loaded from `~/.pinpawo/plugins/*.mjs` or `*.js`.
Each plugin module must export a default object with `{ name }`.

Plugins must export `toolkits`; this keeps tools, operation metadata, and review policy under one owner. A legacy `tools` export is ignored.

```js
import { defineToolkit } from '@pinpawo/pet-agent';

// Use a real LangChain StructuredTool instance here. Its name must match the
// operation metadata key below.
const sampleTool = createYourStructuredTool({ name: 'sample_tool' });

export const toolkits = [
  defineToolkit({
    name: 'sample_plugin',
    description: 'Sample local plugin toolkit',
    tools: [sampleTool],
    operations: {
      sample_tool: {
        kind: 'sample.tool',
        title: 'Sample tool',
      },
    },
  }),
];

export default {
  name: 'sample-plugin',
};
```

## Commands

```bash
pinpawo-agent init
pinpawo-agent login
pinpawo-agent setup
pinpawo-agent actor
pinpawo-agent run
pinpawo-agent run --stdio
pinpawo-agent tui
pinpawo-agent detect
pinpawo-agent browser extension status
pinpawo-agent browser extension register --extension-id <id>
pinpawo-agent browser extension unregister
pinpawo-agent capability list
pinpawo-agent capability validate ./my-capability
pinpawo-agent capability install ./my-capability
```

The packaged extension directory is printed by `browser extension status`. Load it through `chrome://extensions` in Developer mode, copy its ID, register that exact ID, select the `extension` backend, and restart the agent. The Chrome extension is a Browser capability driver, with its Native Messaging host kept as a driver-private companion process. Extension P0 supports opening, snapshotting and detaching one approved Chrome tab.

`pinpawo-agent run --stdio` starts one logical local-agent peer over newline-delimited
JSON. It reads one `LocalAgentClientMessage` per stdin line and writes one
`LocalAgentServerMessage` per stdout line. Stdout is reserved for protocol messages;
diagnostics go to stderr. Stdin EOF closes the peer and aborts its active work before
the process exits. Input framing rejects a JSONL line larger than 8 MiB so malformed
input cannot grow process memory without bound.

The stdio process is self-contained and does not start an HTTP side channel. Use
`ping` / `pong` for liveness. Checkpoint-backed session operations use correlated
request/result messages:

- `session.snapshot.get` → `session.snapshot.result`
- `session.list` → `session.list.result`
- `session.resume` → `session.resume.result`
- failures return `session.error` with the same `requestId`

Session commands from one peer execute in wire arrival order. Chat and review-run
admission waits for preceding session commands, while interrupts remain immediate.
`session.resume` fails with `session.error` if that peer already owns an active run.

These messages only transport the existing session summary and point-in-time
`LocalAgentSessionSnapshot`. They do not introduce another timeline, recovery model,
or source of authority; LangGraph checkpoints remain authoritative.

## Publishing

From the repository root:

```bash
npm run typecheck
npm test
npm run build
npm run pack:dry -w pinpawo-local-agent
npm publish -w pinpawo-local-agent
```
