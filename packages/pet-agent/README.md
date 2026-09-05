# @pinpawo/pet-agent

Shared agent runtime, orchestration, capability, and toolkit contracts for
[PinPawo Agent](https://github.com/pinpawo/pinpawo-agent).

## Install

```bash
npm install @pinpawo/pet-agent
```

The package is ESM-only and requires Node.js 24 or newer. Node 24 LTS and Node 26
are validated for this release.

## Invocation context

Pass the Host's effective working directory and authored system sections through
`runAgent(graph, { messages, context: { workdir, systemPromptSections } })`.
Low-level graph invocations use `{ context: { workdir, systemPromptSections } }`
in their runnable options. Reapply context when resuming a checkpoint; it is not
conversation state. `buildAgentRunnableConfig` projects the shared options for
Hosts that use the graph's streaming API directly.

`actor` is optional invocation metadata for review and attribution. Graph config
no longer accepts an actor, and actor fields do not define the model's persona.
The legacy top-level `workdir`, `runtimeEnvironment` and `execution` invocation
fields were removed. Move workdir to context, authored environment content to
`context.systemPromptSections`, and use the existing `threadId` for thread scope.

## License

[MIT](LICENSE)
