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

## Choose a reading mode

<a id="why-pinpawo-agent"></a>

| Reader need | Start here | Purpose |
|---|---|---|
| Learn by doing | [Getting started](guides/getting-started.md) | First installation and scaffold validation |
| Complete a task | [Guides](guides/index.md) and [Studio configuration](studio/configuration.md) | Configuration and operations |
| Look up facts | [Reference](reference/index.md) | Fields, commands, protocols, and ownership contracts |
| Understand why | [Concepts](concepts/index.md) and [Design records](design/index.md) | System model, rationale, and proposals |

These modes follow [Diátaxis](https://www.diataxis.fr/start-here/). They describe
page purpose; they do not require four new directories. A design proposal's
status still determines whether its claims are accepted.

## Documentation map

| Directory | Contains | Use it for |
|---|---|---|
| [concepts/](concepts/index.md) | Stable vocabulary and system map | Learning the mental model first |
| [guides/](guides/index.md) | Installation, configuration, and integrations | Operating or trying the project |
| [reference/](reference/index.md) | Current APIs, extension, runtime, artifact, and local-tool contracts | Building against a stable boundary |
| [studio/](studio/index.md) | Current Studio overview and configuration | Running or extending Studio |
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

Some current contracts remain at accepted design paths, including
[Resident Pet Host ports](design/agent-runtime/resident-pet-host-ports.md) and
[Channel](design/studio/channel-addressing-and-execution.md). Read their explicit
status rather than inferring authority from the directory alone. Historical
Kanban records also retain their old paths. Old-path summaries and section links
point to successors when a page is reorganized.

## Documentation maintenance

For ordinary edits, follow [Writing and maintenance](contributing.md).

`docs/` is the source-document layer. The synthesized wiki under `docs/wiki/` was
removed as unmaintained; the append-only [maintenance log](log.md) is kept for the
next ingest. See [Documentation Wiki Guidelines](AGENTS.md) before rebuilding the
wiki or modifying `log.md`.
