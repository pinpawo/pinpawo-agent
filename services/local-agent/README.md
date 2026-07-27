# PinPawo CLI

CLI, terminal UI, and local agent runtime for PinPawo.

## Quick Install

Requires Node.js 24 or newer. Node 24 LTS and Node 26 are validated for this
release.

```bash
npm install -g pinpawo
pinpawo init
pinpawo login
pinpawo setup
pinpawo capability validate ~/.pinpawo/capabilities/hello-pinpawo
pinpawo tui
```

For one-off usage without a global install:

```bash
npx pinpawo init
npx pinpawo login
npx pinpawo tui
```

`pinpawo init` creates the quick-start scaffold:

- `~/.pinpawo/.env` with all supported environment keys.
- `~/.pinpawo/capabilities/` for user capabilities.
- `~/.pinpawo/capabilities/hello-pinpawo/` as a minimal capability that validates and loads.

Configuration is read from `~/.pinpawo/config.json`, `~/.pinpawo/.env`, and environment variables. Use `pinpawo login` for interactive credential setup, `pinpawo setup` to check missing config and next steps, or edit `~/.pinpawo/.env` directly. Set `PINPAWO_LOCAL_ONLY=1` to start without hosted API, WebSocket relay, or Hasura GraphQL connections even when saved server credentials exist. Browser `auto` mode prefers a connected Chrome extension for compatible default-session operations and otherwise uses Playwright; force either driver with `PINPAWO_BROWSER_BACKEND=extension` or `playwright`.

For a local repository smoke test:

```bash
npm install
npm run build
node services/local-agent/dist/index.js init --dir /tmp/pinpawo-demo
node services/local-agent/dist/index.js capability validate /tmp/pinpawo-demo/capabilities/hello-pinpawo
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
pinpawo init
pinpawo login
pinpawo setup
pinpawo actor
pinpawo run
pinpawo run --stdio
pinpawo tui
pinpawo tui --v2
pinpawo tui --legacy
pinpawo detect
pinpawo browser extension status
pinpawo browser extension register --extension-id <id>
pinpawo browser extension unregister
pinpawo capability list
pinpawo capability validate ./my-capability
pinpawo capability install ./my-capability
```

`pinpawo tui` remains the legacy Ink client during OpenTUI dogfood.
`pinpawo tui --v2` launches the OpenTUI client. Installed packages use the
Bun-targeted bundle in `dist/tui` together with npm-selected Bun and OpenTUI
platform packages. Source checkouts prefer their workspace Bun dependency and
current TUI source, with a compiled workspace binary, packaged bundle, or global
Bun as fallbacks. `PINPAWO_TUI_V2_BIN` selects an explicit standalone build and
`PINPAWO_BUN_BIN` selects a Bun runtime. `pinpawo tui --legacy` is the rollback
path and will remain available when v2 becomes the default.

The TUI client connects to the separately running local host, so start
`pinpawo run` first. `--workdir` selects the child client's working directory;
the host's canonical snapshot remains authoritative for the runtime workspace.

The packaged extension directory is printed by `browser extension status`. Load it through `chrome://extensions` in Developer mode, copy its ID, register that exact ID, and restart the agent. The Chrome extension is a Browser capability driver, with its Native Messaging host kept as a driver-private companion process. Protocol v2 supports open, snapshot, click, type, scroll, wait, extract, screenshot and detach on one approved Chrome tab.

For the official Chrome Web Store build, run
`pinpawo browser extension register` without `--extension-id`. The option
is only needed for an unpacked development build. Registration preserves the
official Store ID and any previously registered development IDs.

`pinpawo run --stdio` starts one logical local-agent peer over newline-delimited
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

Chat execution is serialized by graph thread, not by connection. A replacement
request signals the preceding invocation to abort, then waits for that invocation's
`streamEvents` run to settle before starting another run on the same thread.
Different threads may continue concurrently on one transport. The client remains
busy until the server reports the actual terminal state; there is no local or
server-side timeout that pretends an invocation has stopped.

These messages only transport the existing session summary and point-in-time
`AgentSessionSnapshot`. They do not introduce another timeline, recovery model,
or source of authority; LangGraph checkpoints remain authoritative.

## Publishing

From the repository root:

```bash
npm run typecheck
npm test
npm run build
npm pack --dry-run -w @pinpawo/pet-agent
npm run pack:dry -w pinpawo
npm publish -w @pinpawo/pet-agent --access public
npm publish -w pinpawo --access public
```
