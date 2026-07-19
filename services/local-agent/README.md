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

Configuration is read from `~/.pinpawo/config.json`, `~/.pinpawo/.env`, and environment variables. Use `pinpawo-agent login` for interactive credential setup, `pinpawo-agent setup` to check missing config and next steps, or edit `~/.pinpawo/.env` directly. Set `PINPAWO_LOCAL_ONLY=1` to start without hosted API, WebSocket relay, or Hasura GraphQL connections even when saved server credentials exist. Browser automation uses Playwright with Google Chrome.

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
pinpawo-agent capability list
pinpawo-agent capability validate ./my-capability
pinpawo-agent capability install ./my-capability
```

`pinpawo-agent run --stdio` starts one logical local-agent peer over newline-delimited
JSON. It reads one `LocalAgentClientMessage` per stdin line and writes one
`LocalAgentServerMessage` per stdout line. Stdout is reserved for protocol messages;
diagnostics go to stderr. This stage carries live messages only: the existing HTTP
snapshot/session endpoints are not started in stdio mode, pending the separate
snapshot/session command boundary decision in #386. Stdin EOF closes the peer and
aborts its active work before the process exits. Input framing rejects a JSONL line
larger than 8 MiB so malformed input cannot grow process memory without bound.

## Publishing

From the repository root:

```bash
npm run typecheck
npm test
npm run build
npm run pack:dry -w pinpawo-local-agent
npm publish -w pinpawo-local-agent
```
