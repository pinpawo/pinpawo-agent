# Workdir Configuration

[简体中文](../../zh-CN/reference/runtime/workdir.md)

> **Status: current local-host configuration.** Path resolution is implemented
> in [`services/local-agent/src/runtimeConfig.ts`](../../../services/local-agent/src/runtimeConfig.ts).

The local host runs against one effective workdir. It resolves the default in
this order: `PINPAWO_WORKDIR`, the stored `workdir` setting, then the current
process directory. Relative and `~/` values are normalized to an absolute path.

```text
<workdir>/
└── .pinpawo/
    ├── studio.json
    ├── pets/
    ├── capability-artifacts/
    ├── checkpoints-capability-v2.json
    ├── checkpoints-tui-capability-v2.json
    └── tui-sessions-capability-v2.json
```

`LocalAgentRuntimeConfig` derives these paths before runtime assembly. Studio
uses `studio.json` and `pets/` from that state root. Capability artifacts and
checkpoint/session files are separate host-owned state. A Studio shared wiki,
due-run store, run identity, and scheduler policy are not part of the current
Studio contract.

The runtime can also expose derived workspace metadata (`id`, `name`, and
`rootPath`) from the workdir. This is local metadata; there is no persisted
workspace registry or per-request workspace selection contract.

The Host captures its effective workdir when it assembles local-machine Toolkit
definitions. The same snapshot is used for relative paths, the default command
cwd, Agent prompts, and review/authorization identity. It is not a filesystem
sandbox: an explicit absolute path or cwd remains authoritative tool input, and
the execution layer does not silently rewrite it. A different workspace is
served by a different Host-scoped inventory rather than mutable process state.

See [Studio configuration](../../studio/configuration.md) for the files Studio
actually reads, and [the workspace proposal](../../design/local-agent/workspace-runtime-config.md)
for unshipped workspace ideas.
