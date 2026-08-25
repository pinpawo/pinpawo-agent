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
| `pinpawo tui` | Start the terminal UI. | `--check`, `--qa`, `--workdir <directory>` |
| `pinpawo-studio` | Start the independent Studio Host. | `--workdir <directory>` and exactly one of `--stdio` or `--port <port>` |
| `pinpawo browser extension <action>` | Manage the Chrome Extension driver. | `--extension-id <id>` |
| `pinpawo capability list` | List installed user Capabilities. | — |
| `pinpawo capability validate <dir>` | Validate one Capability directory. | — |
| `pinpawo capability install <dir>` | Install or link a Capability directory. | `--overwrite`, `--link` |

## Mode rules

- `pinpawo run` is an alias for `pinpawo server`; both always start Chat and
  have no Studio mode.
- Studio is a separate package/process entry. `pinpawo-studio` requires exactly
  one Studio transport and does not reuse the Chat server startup path.
- `--stdio` selects one-peer JSONL stdio instead of the local HTTP/WebSocket
  server; reserve standard output for protocol messages in that mode.
- `pinpawo tui` starts the Chat/local-agent conversation client. It does not
  connect to Studio or send Studio dispatch messages. `--check` and `--qa`
  cannot be used together.
- `--workdir` is resolved to an absolute path before the host starts. It scopes
  runtime state and relative tool paths; see [Workdir configuration](../runtime/workdir.md).

## Automation boundary

Use command exit status and documented JSON output only where a command
explicitly provides it. Do not build automation by parsing general human-facing
diagnostic prose. Capability validation is the supported machine-checkable
boundary before an install; see [Capability directory](../extensions/capability-directory.md).

For installation and a runnable example, use [Getting started](../../guides/getting-started.md).
