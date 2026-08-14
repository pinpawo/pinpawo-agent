# Getting Started

> **Status: current operator guide.** This is the supported path for a local
> installation; detailed interfaces live in [Reference](../reference/index.md).

[简体中文](../zh-CN/guides/getting-started.md)

This guide gets a local PinPawo Agent running, verifies the generated extension
scaffold, and points you to the next integration path.

## Prerequisites

- Node.js 24 or newer
- npm
- An OpenAI-compatible model endpoint and API key

The local host runs on your machine. `PINPAWO_LOCAL_ONLY=1` disables the hosted
PinPawo API, relay, and Hasura connections; it does not replace the model
configuration required to run an agent.

## Install and initialize

```bash
npm install -g pinpawo
pinpawo init
pinpawo login
pinpawo setup
```

`pinpawo init` creates `~/.pinpawo/.env`, a local Capability directory, and a
small `hello-pinpawo` example. `pinpawo login` saves or updates model
configuration interactively. Use `pinpawo setup` whenever you want a concise
diagnostic of missing configuration.

## Verify the scaffold

```bash
pinpawo capability validate ~/.pinpawo/capabilities/hello-pinpawo
pinpawo capability list
```

The example is a `CAPABILITY.md` document. A Capability describes its user
facing task and the Toolkits it is allowed to use; it is not an arbitrary code
plugin. Read [Core Concepts](../concepts/core-concepts.md) before building a larger one.

## Run the agent

For the interactive terminal client:

```bash
pinpawo tui
```

For the OpenTUI client:

```bash
pinpawo tui --v2
```

For a local server or process integration:

```bash
pinpawo server
pinpawo server --stdio
```

`--stdio` uses one JSONL peer and reserves standard output for protocol
messages. See the [CLI reference](../reference/api/cli.md) for the
complete command surface.

## Develop from a checkout

```bash
npm install
npm run typecheck
npm test
npm run build
```

Run the source TUI with:

```bash
npm run tui -w pinpawo
```

## Add a Capability

Create a directory with `CAPABILITY.md`:

```md
---
name: repository-audit
description: "Inspect a repository and report verified risks."
uses:
  - bash
  - git
version: 1
---

# Repository audit

Inspect the requested scope, cite the evidence you found, and summarize the
risks and recommended next actions.
```

Validate it before installation:

```bash
pinpawo capability validate ./repository-audit
pinpawo capability install ./repository-audit --link
```

Use `--link` while developing so the agent loads your source directory in
place. The full format, optional lifecycle hook, and Toolkit boundary are
defined in the [Capability directory protocol](../reference/extensions/capability-directory.md).

## Choose the next guide

- [Architecture](../concepts/architecture.md) — understand package and runtime boundaries.
- [Capability / Toolkit V2 contract](../reference/extensions/capability-toolkit.md) —
  build extensions safely.
- [Model profile configuration](model-profiles.md) — configure
  multiple models or custom endpoints.
- [Chrome extension browser backend](browser-bridge.md) — connect a
  browser session.
- [Studio configuration](../studio/configuration.md) — configure multi-Pet
  dispatch and plugins.
