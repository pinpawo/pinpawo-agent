# PinPawo Agent Documentation

PinPawo Agent is an open-source, local-first framework for agents that use
real tools with explicit authority, human review, checkpoint-backed recovery,
and composable extensions. This directory is organized by the role a document
plays, so a reader can distinguish the current contract from a proposal or a
record of an earlier implementation.

[简体中文](zh-CN/index.md)

## Start here

| If you want to… | Read this |
|---|---|
| Install and run a local agent | [Getting started](guides/getting-started.md) |
| Understand the project vocabulary and value | [Core concepts](concepts/core-concepts.md) |
| See the package and runtime boundaries | [Architecture](concepts/architecture.md) |
| Build an extension | [Capability / Toolkit contract](reference/extensions/capability-toolkit.md) |
| Integrate a runtime or client | [API reference](reference/api/index.md) |
| Coordinate multiple specialized agents | [Studio](studio/index.md) |

## Why PinPawo Agent

- **Local control:** the host, tools, browser bridge, and runtime state run on
  the machine chosen by the operator; model-provider choice remains yours.
- **Explicit authority:** each Capability has a declared Toolkit allowlist, and
  Toolkit policy can pause an operation for a human decision.
- **Recoverable work:** durable checkpoints and one session projection make
  review, reconnection, and client rendering predictable.
- **Composable extensions:** task instructions live in reviewable Markdown;
  executable behavior and side-effect policy live in typed Toolkits.
- **A practical route to multi-agent work:** Studio provides a shared dispatch
  channel and plugin boundary without making every worker share private scratch
  state.

## Documentation map

| Directory | Contains | Use it for |
|---|---|---|
| [concepts/](concepts/index.md) | Stable vocabulary and system map | Learning the mental model first |
| [guides/](guides/index.md) | Installation, configuration, and integrations | Operating or trying the project |
| [reference/](reference/index.md) | Current APIs, extension, runtime, artifact, and local-tool contracts | Building against a stable boundary |
| [studio/](studio/index.md) | Current multi-agent push model, configuration, host integration, and API links | Running or extending Studio |
| [design/](design/index.md) | Proposals and implementation rationale | Changing a subsystem |
| [history/](history/index.md) | Superseded designs, audits, and completed migration records | Understanding why a boundary changed |
| [references/](references/openclaw-agent-loop-reference.md) | External comparison material | Research only; not repository authority |

The public reading path is available in English and Simplified Chinese. Current
contracts link to their translated overview where available; code identifiers,
commands, and source paths intentionally remain in English.

## How to read document status

When two pages appear to disagree, use this order of authority:

1. Current implementation and tests establish observed behavior.
2. Pages in `reference/` and explicitly **Current** or **canonical** pages
   establish the intended public contract.
3. Pages in `design/` explain an implementation direction or a proposal; they
   may not yet be complete.
4. Pages in `history/` explain previous decisions and must not override a
   current contract.

There are no compatibility redirects in this directory. Current pages use their
categorized, lowercase paths directly; obsolete implementations are retained
only under `history/`.

Interrupt and Resident Pet design work is split by boundary. [Pending interrupt
in Chat](design/local-agent/pending-interrupt-chat.md) defines the checkpoint,
projection, and resume boundary for Agent Session conversation. [Pet dispatch
and conversation continuity](design/studio/pet-thread-dispatch-invocation.md) and
[Resident Pet Host ports](design/agent-runtime/resident-pet-host-ports.md) define
the accepted target: Studio dispatch is one-way, Agent Session owns the active
thread and continuation recovery, and conversation has non-preemptive scheduling
priority. Reference pages identify fixed Pet threads, dispatch resume and the
built-in Studio wire as transitional wherever implementation has not migrated.

## Documentation maintenance and future wiki ingest

`docs/` is the source-document layer. The synthesized
[documentation wiki](wiki/index.md) and its [maintenance log](log.md) remain a
later ingest layer and are intentionally unchanged by this reorganization. See
[Documentation Wiki Guidelines](AGENTS.md) before ingesting into `wiki/` or
modifying `log.md`.
