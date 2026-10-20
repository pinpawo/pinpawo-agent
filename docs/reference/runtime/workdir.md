# Workdir Configuration

[简体中文](../../zh-CN/reference/runtime/workdir.md)

> **Status: current local-host configuration.** Path resolution is implemented
> in [`services/host/src/config/runtimeConfig.ts`](../../../services/host/src/config/runtimeConfig.ts).

The local host runs against one effective workdir. It resolves the default in
this order: `PINPAWO_WORKDIR`, the stored `workdir` setting, then the current
process directory. Relative and `~/` values are normalized to an absolute path.

```text
<workdir>/
├── PET.md
└── .pinpawo/                     # project config (stateRoot)
    ├── studio.json
    ├── studio/studio.sqlite
    └── pets/

~/.pinpawo/workspaces/<workspace-id>/   # sessions (sessionRoot)
├── workspace.json
├── capability-artifacts/
├── checkpoints-capability-v5/
├── checkpoints-tui-capability-v5/
├── checkpoints-studio-capability-v5/
├── resident-sessions/
└── tui-sessions-capability-v5.json
```

`HostRuntimeConfig` derives these paths before runtime assembly. Studio
uses `studio.json` and `pets/` from the workdir state root. Session state
(checkpoints of every Host, session registries and capability artifacts) lives
under the user's home, one directory per workdir named by its derived workspace
id (`local-` plus a hash of the path); `workspace.json` records the workdir it
belongs to. One directory per workdir keeps Hosts running in different projects
from contending for one checkpoint writer lease. `PINPAWO_WORKSPACES_DIR`
replaces `~/.pinpawo/workspaces` as the base. Session state is not migrated:
moving or renaming a workdir starts with no sessions, and session files that
an older version left in `<workdir>/.pinpawo` are reported at Host start and
can be deleted.

A Studio shared wiki, due-run store, run identity, and scheduler policy are not
part of the current Studio contract.

The single-Pet Chat Host reads `<workdir>/PET.md` as that Pet's root document.
Studio resolves the same `PetDocument` contract from each configured Pet's
directory instead.

The runtime also exposes derived workspace metadata (`id`, `name`, and
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

Workdir is a path-resolution base, not a filesystem sandbox. The files, shell,
web, git, github and project-inspection Toolkit bindings resolve supported relative paths and
relative or omitted `cwd` against the execution workdir. Absolute paths remain
absolute. These bindings do not change the process-wide cwd; independent Hosts
can therefore keep separate execution scopes in one process. The implementation
is `withExecutionWorkdir()` in
[executionContext.ts](../../../services/host/src/toolkits/executionContext.ts).

See [Studio configuration](../../studio/configuration.md) for the files Studio
actually reads, and [the workspace proposal](../../design/host/workspace-runtime-config.md)
for unshipped workspace ideas.
