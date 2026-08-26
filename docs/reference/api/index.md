# API Reference

> **Status: current reference index.** API pages are organized by the boundary
> that owns the behavior; do not use historical design pages as API contracts.

[简体中文](../../zh-CN/reference/api/index.md)

This index covers PinPawo Agent's public programming, CLI, and extension
surfaces. It is reference material: for the system model and architecture, read
[Core Concepts](../../concepts/core-concepts.md) and [Architecture](../../concepts/architecture.md) first.

## Choose an integration surface

| You need to… | Reference |
|---|---|
| Compose a resident Pet Host | [Resident Pet Host ports](../../design/agent-runtime/resident-pet-host-ports.md) |
| Coordinate multiple pet runtimes | [Studio API](studio.md) |
| Author a task-specific extension | [Capability / Toolkit V2 contract](../extensions/capability-toolkit.md) |
| Load a local `CAPABILITY.md` extension | [Capability directory protocol](../extensions/capability-directory.md) |
| Render tool activity or approval UI | [Events and human review API](events-and-review.md) |
| Operate through a terminal or process | [CLI reference](cli.md) |
| Diagnose failures or record safe telemetry | [Error handling and observability](error-handling.md) |

## Public surface map

- [API overview](overview.md) — ownership boundaries across the
  runtime, local host, extensions, and Studio.
- [Resident Pet Host ports](../../design/agent-runtime/resident-pet-host-ports.md) —
  resident runtime, dispatch, Agent Session interaction, and lifecycle ownership.
- [Studio API](studio.md) — multi-pet dispatch, runtime-gate, event, and plugin
  interfaces.
- [Capability / Toolkit V2 contract](../extensions/capability-toolkit.md) —
  current extension and tool-authority contract.
- [Capability directory protocol](../extensions/capability-directory.md) — local
  extension file format and lifecycle restriction.
- [Events and human review API](events-and-review.md) — operational
  events, review actions, and interaction boundaries.
- [CLI reference](cli.md) — `pinpawo` commands and
  runtime modes.
- [Error handling and observability](error-handling.md) — error
  classes, diagnostics, and disclosure boundaries.

## Related current contracts

- [Local-agent session projection](../runtime/session-projection.md) — shared
  checkpoint-to-client session contract.
- [Capability Artifact Pipeline](../artifacts/index.md) —
  durable Capability output contract.
- [Model profile configuration](../../guides/model-profiles.md) — model identity
  and non-secret configuration handling.

## Design background

Some API behavior is motivated by detailed design records. They explain why a
boundary exists but do not override a current contract:

- [Toolkit composition design](../../design/agent-runtime/toolkit-composition.md)
- [Studio independent Host runtime](../../design/studio/independent-host-runtime.md)
- [Capability Artifact Store design](../artifacts/store.md)
- [Documentation index](../../index.md) for the full design-record catalog
