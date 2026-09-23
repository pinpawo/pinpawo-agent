# PinPawo CLI

CLI, terminal UI, and local agent runtime for PinPawo.

## Quick Install

Requires Node.js 24 or newer. Node 24 is validated for this release.

```bash
npm install -g pinpawo
pinpawo init
pinpawo setup
pinpawo capability validate ~/.pinpawo/capabilities/hello-pinpawo
pinpawo tui
```

For one-off usage without a global install:

```bash
npx pinpawo init
npx pinpawo tui
```

`pinpawo init` creates the quick-start scaffold:

- `~/.pinpawo/.env` with optional local runtime settings.
- `~/.pinpawo/config.json` with an editable default model profile.
- `~/.pinpawo/capabilities/` for user capabilities.
- `~/.pinpawo/capabilities/hello-pinpawo/` as a minimal capability that validates and loads.

Configuration is read from `~/.pinpawo/config.json`, `~/.pinpawo/.env`, and environment variables. Runnable models are stored as versioned profiles under `config.json#models`; use `PINPAWO_MODEL_PROFILE` to select a stored profile. Credentials and endpoints are read only from the stored profile. `pinpawo init` creates an editable profile template and migrates a complete legacy `.env` model tuple when no `config.json` exists. Use `pinpawo setup` to check missing config and next steps. Shell and CDP browser instances are configured separately in `~/.pinpawo/runtime/config.json`.

Programmatic Chat and Studio Hosts resolve execution settings once with
`resolveHostExecutionConfig(runtimeConfig, settings)`. The resolved settings own
runtime paths, review mode, authorization safety level and registry backend.
Agent input construction receives these settings explicitly. Model profiles no
longer carry review policy. Temperature, thinking and reasoning effort use provider defaults for every role.
The former `temperature` / `subagentThinking` inputs and stored `subagent_thinking`
setting are no longer consumed. Conversation and background dispatch share the same
Host policy store, so changes apply consistently to subsequent runs.

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
pinpawo setup
pinpawo server
pinpawo run
pinpawo server --stdio
pinpawo tui
pinpawo tui --server-port 3210
pinpawo runtime start
pinpawo runtime status
pinpawo runtime stop
pinpawo capability list
pinpawo capability validate ./my-capability
pinpawo capability install ./my-capability
```

Studio is an independent Host exposed through `@pinpawo/studio`, not a mode of
this Chat server command. The `pinpawo-studio` process entry lives directly in
`packages/studio`.

`pinpawo tui` launches the OpenTUI client. Installed packages use the
Bun-targeted bundle in `dist/tui` together with npm-selected Bun and OpenTUI
platform packages. Source checkouts prefer their workspace Bun dependency and
current TUI source, with a compiled workspace binary, packaged bundle, or global
Bun as fallbacks. `PINPAWO_TUI_V2_BIN` selects an explicit standalone build and
`PINPAWO_BUN_BIN` selects a Bun runtime.

`pinpawo tui --check` walks the same launch-plan, integrity, and
package-local runtime path without entering terminal mode. It prints the v2
version only after the selected bundle and external OpenTUI runtime load
successfully.

By default the terminal client starts its own local agent as a stdio child
process and speaks the same JSONL protocol over the pipe, so `pinpawo tui` needs
no separately started Host. The launcher resolves the Host runtime and forwards it
as `PINPAWO_EMBED_HOST_COMMAND` / `PINPAWO_EMBED_HOST_ARGS`; without them the
client falls back to `pinpawo` on `PATH`. This default needs no port, auth token,
or loopback origin check, and the Host's stderr is appended to
`~/.pinpawo/logs/embedded-host.log` instead of the terminal. Quitting the client
ends the Host, so this mode cannot attach to an already running Host.

`pinpawo tui --server-port <port>` switches the client back to dialing a
separately running Host instead, which is why it requires `pinpawo run` to be
started first. `LOCAL_SERVER_PORT` supplies the default port for connection modes
that do not name one. `--workdir` selects the child client's working directory;
the host's canonical snapshot remains authoritative for the runtime workspace.

Because one session has exactly one transport owner, `--embed-host` (which only
restates the default) is mutually exclusive with `--server-port`,
`--pet-port`/`--pet-id`, `--check`, and `--qa`.

## Toolkit Runtime Service

Chat and Studio ensure one independent Toolkit Runtime Service is running, then connect
as clients. The service owns Shell environments, background processes, CDP
connections and browser pages. Closing one Host releases that client's resources;
the service remains available to other Hosts. `pinpawo runtime stop` explicitly
stops the service for every attached Host.

The service reads `~/.pinpawo/runtime/config.json`; `PINPAWO_RUNTIME_DIR` or the
Runtime commands' `--directory <path>` option selects another directory. Without
a config file, `bash`, `git` and `project-inspection` share the `local` Shell
instance, and `browser` uses its own CDP instance. To isolate Git, for example:

```json
{
  "instances": {
    "local": { "kind": "shell" },
    "git-env": { "kind": "shell" },
    "browser": { "kind": "cdp" }
  },
  "toolkitBindings": {
    "bash": "local",
    "project-inspection": "local",
    "git": "git-env",
    "browser": "browser"
  }
}
```

A Shell instance provides a configured environment for shell and CLI commands.
It does not require one permanent shell process. The service snapshots its
startup environment; an instance can configure `shell`, `env`, absolute
`programs` paths and an absolute `pathBase` for relative PATH entries. The default
shell is bash or zsh on POSIX and PowerShell on Windows. Commands receive an
explicit cwd from the current execution. Changes to service configuration or its
startup environment require a service restart and fresh Host connections.
The persistent service inherits only basic OS environment variables, not
project `.env` secrets loaded by the first Host. Put required instance variables
in the service config's `env`. A failed instance initialization can retry after
a short delay. After a service disconnect, the next Tool call reconnects with a
new client identity; unfinished calls are never replayed and old handles expire.
If the service cannot connect during Host startup, Runtime-dependent Toolkits are
reported unavailable while Host-only Toolkits remain usable. Restart the Host
after correcting the service configuration.

Host Toolkit Runtime requirements declare `runtimeKind: 'shell'` or `runtimeKind: 'cdp'`; the
`AgentToolkit` definitions carry no execution metadata. The Host
injects async clients; static Tools are retained across executions. The selected
Capability receives only the clients for its `uses` dependencies. Local tools
resolve relative file paths and cwd through `ToolDefinition.prepareInput`
before review so the reviewed input is also the executed input. See the
[Runtime contract](../../docs/reference/extensions/toolkit-runtime.md) and
[workdir reference](../../docs/reference/runtime/workdir.md).

The Browser Toolkit uses CDP only, either with managed Chrome or a configured
local endpoint. Remove `PINPAWO_BROWSER_BACKEND` and `browser_backend`; extension
registration, Native Messaging and backend fallback have been removed. Follow
the [CDP browser guide](../../docs/guides/browser-bridge.md) for browser setup.

## Stdio Transport

`pinpawo run --stdio` starts one logical local-agent peer over newline-delimited
JSON. It reads one `LocalAgentClientMessage` per stdin line and writes one
`LocalAgentServerMessage` per stdout line. Stdout is reserved for protocol messages;
diagnostics go to stderr. Stdin EOF closes the peer and aborts its active work before
the process exits. Input framing rejects a JSONL line larger than 8 MiB so malformed
input cannot grow process memory without bound.

The stdio transport does not start an HTTP side channel; Runtime operations use
the shared service's local IPC connection. Use
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
npm run test:distribution -w @pinpawo/tui
npm run test:tui-install -w pinpawo
npm run pack:dry -w @pinpawo/agent-session
npm pack --dry-run -w @pinpawo/pet-agent
npm run pack:dry -w pinpawo
npm publish -w @pinpawo/agent-session --access public
npm publish -w @pinpawo/pet-agent --access public
npm publish -w pinpawo --access public
```

The packaged OpenTUI launcher verifies `dist/tui/main.js` against the byte
count and SHA-256 recorded in its versioned manifest before starting Bun.
The prepublish gate also builds a fresh payload and executes its non-interactive
version probe, proving that the bundle can load the package's external OpenTUI
runtime without entering terminal mode.
The separate `test:tui-install` release smoke packs the local runtime and CLI,
installs both tarballs with normal dependency lifecycle scripts in an empty
project, then runs the installed CLI's `tui --check` path. It uses a bounded
workspace cache and per-stage timeouts so registry or install failures remain
diagnosable; unlike the prepublish gate, it requires registry access.
Launcher tests cover the package-local Bun runtime on darwin, Linux, and
Windows for x64 and arm64. Windows starts the direct `bun.exe` instead of an
npm command shim. Executable smoke tests still need to run on each target OS
before changing the default TUI.
