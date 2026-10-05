# PinPawo Agent

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/brand/pinpawo-primary-white-lockup.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/brand/pinpawo-primary-black-lockup.svg">
  <img alt="PinPawo" src="assets/brand/pinpawo-primary-black-lockup.svg" width="320">
</picture>

Open-source agent runtime, local CLI/TUI, browser Toolkit, and Studio for PinPawo.
The public stack runs locally; the private app and hosted backend live elsewhere.

## Quick Start

Requires Node.js 24 or newer, npm, and an OpenAI-compatible model endpoint.

```bash
npm install -g pinpawo
pinpawo init
```

Configure the generated model profile in `~/.pinpawo/config.json`. Then run:

```bash
pinpawo setup
pinpawo tui
```

Follow [Getting started](docs/guides/getting-started.md) for configuration,
scaffold validation, and server alternatives.

## Documentation

[Documentation index](docs/index.md) · [简体中文](docs/zh-CN/index.md)

| Your goal | Entry |
|---|---|
| Understand Pet, Capability, and Toolkit | [Core concepts](docs/concepts/core-concepts.md) |
| Integrate a runtime or client | [API reference](docs/reference/api/index.md) |
| Coordinate multiple Pets | [Studio](docs/studio/index.md) |
| Improve documentation | [Writing and maintenance](docs/contributing.md) |

## Vision

The [agent harness explanation](docs/concepts/agent-harness.md) describes the
project's engine analogy and the repeated perceive, reason, act, and state loop.

<a id="the-engine-of-the-intelligence-revolution"></a>
<a id="the-essence-of-the-loop-energy--air-vs-token--context"></a>

## Highlights

- Checkpoint-backed sessions and human review.
- Isolated Capability delegation with typed Toolkit contracts.
- Browser automation through an existing Chrome session.
- Studio dispatch, per-Pet queue observation, and Plugin workflows.

## Architecture

See [Architecture](docs/concepts/architecture.md) for package, runtime, and state ownership.

## Repository Layout

Runtime packages live in `packages/`; local Host and TUI live in `services/`.
Studio Plugins live in `plugins/`, and Toolkits live in `toolkits/`.
See the [package map](docs/concepts/architecture.md) and [workspace scripts](package.json).
The macOS companion under `tools/agent-macos/` is suspended; see [AGENTS.md](AGENTS.md).

## Requirements

See [Getting started](docs/guides/getting-started.md#prerequisites).

## Local Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

Start the source TUI with `npm run tui -w pinpawo`.

## Configuration

Use [Model profiles](docs/guides/model-profiles.md) for model setup and selection.
Use [Studio configuration](docs/studio/configuration.md) for a Studio workdir.

## CLI

See the [CLI reference](docs/reference/api/cli.md) and [Studio CLI](packages/studio/README.md).

## Capabilities and Plugins

See the [Capability directory protocol](docs/reference/extensions/capability-directory.md)
and [Capability / Toolkit contract](docs/reference/extensions/capability-toolkit.md).
Local Plugin loading is documented in the [Host README](services/host/README.md).

## Browser Toolkit

Follow [Browser bridge setup](docs/guides/browser-bridge.md).

## Runtime State

See [Architecture](docs/concepts/architecture.md) for state owners and
[Session projection](docs/reference/runtime/session-projection.md) for recovery.

## Quality Gates

Use the commands under [Local Development](#local-development).
Include the checks you actually ran and any failures in your PR.

## Security

Never commit credentials, checkpoints, local session state, or generated output.
See [Repository guidelines](AGENTS.md) and the [security boundaries](docs/concepts/architecture.md).

## Contributing

Follow [AGENTS.md](AGENTS.md). Documentation changes follow
[Writing and maintenance](docs/contributing.md).

## Publishing

Review package contents and release commands in the
[Host README](services/host/README.md) and [Studio README](packages/studio/README.md).

## License

Licensed under the [MIT License](LICENSE).
