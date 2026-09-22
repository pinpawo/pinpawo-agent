# Workdir Configuration

[简体中文](../../zh-CN/reference/runtime/workdir.md)

> **Status: current local-host configuration.** Path resolution is implemented
> in [`services/local-agent/src/config/runtimeConfig.ts`](../../../services/local-agent/src/config/runtimeConfig.ts).

The local host runs against one effective workdir. It resolves the default in
this order: `PINPAWO_WORKDIR`, the stored `workdir` setting, then the current
process directory. Relative and `~/` values are normalized to an absolute path.

```text
<workdir>/
├── PET.md
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

The single-Pet Chat Host reads `<workdir>/PET.md` as that Pet's root document.
Studio resolves the same `PetDocument` contract from each configured Pet's
directory instead.

The runtime can also expose derived workspace metadata (`id`, `name`, and
`rootPath`) from the workdir. This is local metadata; there is no persisted
workspace registry or per-request workspace selection contract.

The Host supplies its resolved directory as `AgentInvokeInput.context.workdir`;
low-level graph calls pass `context.workdir` in their runnable options. The shared
system-message composer renders this fact once for Entry, Supervisor, Capability
execution and final Answer. Review context and Toolkit Runtime execution scopes
read the same structured value. Host machine/session facts use common system
sections and do not repeat the directory. The legacy `runtimeEnvironment` and
`configurable.workdir` channels are removed.

Context is supplied again on every invocation, including checkpoint resume. It
is not restored from conversation history, and the generic agent runtime does not
infer a directory from process globals.

Workdir is a path-resolution base, not a filesystem sandbox. The local bash,
project-inspection and Git Toolkits use `ToolDefinition.prepareInput` to resolve
supported relative paths and relative or omitted `cwd` against the execution
workdir **before review**. Absolute paths remain absolute; a relative path without
an absolute execution workdir fails. Review and execution consume the prepared
input, including in full-access mode where no human review is requested. Static
Tools are retained; no per-execution Tool binding or process-wide cwd change is
needed. The implementation is
[workdirBinding.ts](../../../services/local-agent/src/toolkits/local/workdirBinding.ts).

Shell and CDP resources live in the independent local Runtime service. Multiple
Hosts and Toolkits may share one configured instance while supplying separate
execution scopes and cwd values. `~/.pinpawo/runtime/config.json` (or
`PINPAWO_RUNTIME_DIR`) chooses service instances independently of workdir.
Authorization reuse includes the Toolkit, connected client, instance and workdir;
switching an environment or directory cannot reuse the previous target's grant.
See the [Toolkit Runtime contract](../extensions/toolkit-runtime.md).

See [Studio configuration](../../studio/configuration.md) for the files Studio
actually reads, and [the workspace proposal](../../design/local-agent/workspace-runtime-config.md)
for unshipped workspace ideas.
