# CLI Reference

> **Status: current contract.** Command registration is implemented in
> [`services/local-agent/src/cli.ts`](../../../services/local-agent/src/cli.ts).

[简体中文](../../zh-CN/reference/api/cli.md)

`pinpawo` is the local host entry point. With no subcommand it starts
`pinpawo server` in chat mode.

## Commands

| Command | Purpose | Important options |
|---|---|---|
| `pinpawo init` | Create local configuration and the example Capability. | `--dir <directory>`, `--force`, `--no-example-capability` |
| `pinpawo setup` | Diagnose local model and runtime configuration. | `--workdir <directory>` |
| `pinpawo server` / `pinpawo run` | Start the local Chat host. | `--workdir <directory>`, `--stdio` |
| `pinpawo tui` | Start the terminal UI. | `--check`, `--qa`, `--embed-host`, Chat-only `--workdir <directory>`, `--server-port <port>`, or paired `--pet-port <port>` and `--pet-id <petId>` |
| `pinpawo-studio` | Start the independent Studio Host. | `--workdir <directory>`, `--pet-port <port>` |
| `pinpawo runtime start / status / stop` | Start, inspect, or stop the shared local Runtime service. | `--directory <path>` |
| `pinpawo capability list` | List installed user Capabilities. | — |
| `pinpawo capability validate <dir>` | Validate one Capability directory. | — |
| `pinpawo capability install <dir>` | Install or link a Capability directory. | `--overwrite`, `--link` |

## Mode rules

- `pinpawo run` is an alias for `pinpawo server`; both always start Chat and
  have no Studio mode.
- Studio is a separate package/process entry and does not reuse the Chat server
  startup path. Configured Plugins provide its HTTP control plane.
- `--stdio` selects one-peer JSONL stdio instead of the local HTTP/WebSocket
  server for the Chat Host; reserve standard output for protocol messages in that mode.
- `pinpawo-studio --pet-port` optionally fixes the resident Pet conversation listener;
  if omitted, Studio selects an available loopback port.
- `pinpawo tui` starts the Chat/local-agent conversation client. It does not
  connect to the Studio control plane or send Studio dispatch messages. By default
  it starts its own local agent as a stdio child process, so no separately running
  Host is needed. The launcher forwards the resolved Host runtime through
  `PINPAWO_EMBED_HOST_COMMAND` and `PINPAWO_EMBED_HOST_ARGS`; when they are absent
  the client falls back to `pinpawo` on `PATH`. The Host's stderr is appended to
  `~/.pinpawo/logs/embedded-host.log`. Exiting the client ends the Host.
- `pinpawo tui --server-port <port>` instead dials a local agent Chat server that
  is already listening on that loopback port, using its bearer token and origin
  check. `LOCAL_SERVER_PORT` supplies the default port for connection modes that do
  not name one. An embedded Host cannot attach to a running Host, so
  `--embed-host` is mutually exclusive with `--server-port`, `--pet-port`/`--pet-id`,
  `--check`, and `--qa`; passing it only restates the default.
- The paired `--pet-port` and `--pet-id` options select one resident Pet's
  local-agent Agent Session endpoint instead. Pet connection mode does not accept
  `--workdir` or `--server-port`: the Studio Host already resolved and owns the
  resident Pet workdir. `--check` and `--qa` cannot be used together.
- `--workdir` is resolved to an absolute path before the host starts. It scopes
  runtime state and relative tool paths; see [Workdir configuration](../runtime/workdir.md).

## Runtime service

Host startup ensures the independent Runtime service is running. `runtime start`
does the same explicitly and prints a JSON status snapshot; `runtime status`
connects to an existing service and prints its status. `runtime stop` requests
shutdown and prints a confirmation. Status and stop do not start a missing service.

The service directory defaults to `~/.pinpawo/runtime`. `PINPAWO_RUNTIME_DIR`
overrides it; `--directory` overrides that value for the Runtime command. Its
`config.json` defines named instances and `toolkitBindings`. By default `bash`,
`git` and `project-inspection` share a Shell instance, and `browser` uses CDP.
The directory and instance selection are independent of each Host's `--workdir`.

Closing a Host releases that connection's resources and leaves the service
running. Explicitly stopping the service affects all attached Hosts. Changing
configuration requires a service restart and fresh Host connections; existing
clients do not silently reconnect or replay operations.

Browser extension commands and backend selection have been removed. Remove
`PINPAWO_BROWSER_BACKEND` and stored `browser_backend` settings; configure the
CDP instance in the service config. See the [CDP browser guide](../../guides/browser-bridge.md).

## Automation boundary

Use command exit status and documented JSON output only where a command
explicitly provides it. Do not build automation by parsing general human-facing
diagnostic prose. Capability validation is the supported machine-checkable
boundary before an install; see [Capability directory](../extensions/capability-directory.md).

For installation and a runnable example, use [Getting started](../../guides/getting-started.md).
