# API Reference

> **Status: current reference index.** Choose the boundary that owns the behavior.

[简体中文](../../zh-CN/reference/api/index.md)

Start with the [API overview](overview.md) for ownership across packages.
For the system model, read [Core concepts](../../concepts/core-concepts.md) and
[Architecture](../../concepts/architecture.md).

## Choose an integration surface

| You need to… | Reference |
|---|---|
| Compose a resident Pet Host | [Resident Pet Host ports](../../design/agent-runtime/resident-pet-host-ports.md) — accepted and implemented; path retained in the design layer |
| Coordinate multiple Pets | [Studio API](studio.md) |
| Author a task-specific extension | [Capability / Toolkit contract](../extensions/capability-toolkit.md) |
| Load a local `CAPABILITY.md` | [Capability directory protocol](../extensions/capability-directory.md) |
| Render tool activity or approval UI | [Events and human review API](events-and-review.md) |
| Use a terminal or process | [CLI reference](cli.md) |
| Diagnose failures or record safe telemetry | [Error handling and observability](error-handling.md) |

## Public surface map

The table above is the surface catalog. The [API overview](overview.md) maps each
surface to its package owner.

## Related current contracts

- [Session projection](../runtime/session-projection.md) — checkpoint-to-client state.
- [Capability artifacts](../artifacts/index.md) — durable Capability output.
- [Model profiles](../runtime/model-profiles.md) — identity, fields, and modality rules.
- [Runtime contracts](../runtime/index.md) — authorization, guards, and context boundaries.

## Design background

Use [Design records](../../design/index.md) for proposals and accepted rationale,
including the [Studio Host](../../design/studio/independent-host-runtime.md).
A design record's explicit status determines its role. The
[documentation index](../../index.md#how-to-read-document-status) explains source authority.
