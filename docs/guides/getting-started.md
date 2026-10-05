# Getting Started

> **Status: current first-use guide.** Detailed interfaces live in
> [Reference](../reference/index.md).

[简体中文](../zh-CN/guides/getting-started.md)

Use this guide to install a local agent and validate its generated Capability.
You will then choose a TUI or server entry point.

## Prerequisites

- Node.js 24 or newer
- npm
- An OpenAI-compatible model endpoint and API key

The local host runs entirely on your machine. It needs no PinPawo account or
backend — only the model configuration above.

## Install and initialize

```bash
npm install -g pinpawo
```

Initialize local configuration:

```bash
pinpawo init
```

`pinpawo init` creates `~/.pinpawo/.env`, `~/.pinpawo/config.json` with an
editable default model profile, a local Capability directory, and a small
`hello-pinpawo` example.

Open `~/.pinpawo/config.json`. Configure the model endpoint and credentials in
its `models` section. The Host reads these from the stored profile. Keep
`~/.pinpawo/.env` for runtime settings.

Check for missing configuration:

```bash
pinpawo setup
```

If setup reports missing model configuration, follow
[Model profile configuration](model-profiles.md), then run setup again.

## Verify the scaffold

```bash
pinpawo capability validate ~/.pinpawo/capabilities/hello-pinpawo
pinpawo capability list
```

The validator returns JSON with `ok: true` when validation succeeds.
The list command shows installed Capabilities. Before creating your own, read
[Core concepts](../concepts/core-concepts.md) and the
[Capability directory protocol](../reference/extensions/capability-directory.md).

## Run the agent

For the OpenTUI terminal client:

```bash
pinpawo tui
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
- [Chrome extension browser](browser-bridge.md) — connect a
  browser session.
- [Studio configuration](../studio/configuration.md) — configure multi-Pet
  dispatch and plugins.
