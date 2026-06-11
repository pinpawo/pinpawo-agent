# PinPawo Local Agent

Local CLI/TUI agent client for PinPawo.

## Quick Install

Requires Node.js 20.x.

```bash
npm install -g pinpawo-local-agent
pinpawo-agent init
pinpawo-agent login
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

Configuration is read from `~/.pinpawo/config.json`, `~/.pinpawo/.env`, and environment variables. Use `pinpawo-agent login` for interactive credential setup, or edit `~/.pinpawo/.env` directly. Browser automation uses the optional bundled browser backend when available, or an externally installed `agent-browser` / `playwright-core`.

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
pinpawo-agent actor
pinpawo-agent run
pinpawo-agent tui
pinpawo-agent detect
pinpawo-agent capability list
pinpawo-agent capability validate ./my-capability
pinpawo-agent capability install ./my-capability
```

## Publishing

From the repository root:

```bash
npm run typecheck
npm test
npm run build
npm run pack:dry -w pinpawo-local-agent
npm publish -w pinpawo-local-agent
```
