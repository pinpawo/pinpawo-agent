# Studio

[简体中文](../zh-CN/studio/index.md)

> **Status: current contract.** Studio is implemented by
> [`@pinpawo/studio`](../../packages/studio/src/index.ts), which owns its Host,
> runtime assembly, and Plugin composition. It reuses local Host assembly
> through the public host
> [`host-runtime`](../../services/host/src/hostRuntime.ts) surface; the
> Pet Agent Session adapter is a separate `wire` surface.
> The `pinpawo-studio` executable entry also lives in this package. Concrete
> Plugins remain externally injected through `StudioPluginResolver`.

Studio is a small dispatch-admission substrate for multiple Pet runtimes. It
keeps a registry of dispatchable pets and gives plugins an in-process event bus.
The resident runtime owns queueing and the gate. Studio is deliberately not a
workflow engine.

```text
Plugin A ── notify(event) ──> Studio event bus ── subscribe ──> Plugin B
Plugin   ── dispatch(request) ──> Studio ── PetDispatchPort ──> Pet
```

`dispatch()` immediately acknowledges acceptance with a new invocation identity.
The receipt does not track execution. Agent activity is projected by Agent
Session events, while Plugin domain outcomes are reported through Plugin-owned
Toolkits and state.

## Read in this order

- [Independent Host runtime](../design/studio/independent-host-runtime.md) — Host,
  process, Plugin, dispatch, and interaction ownership.
- [Resident Pet Host ports](../design/agent-runtime/resident-pet-host-ports.md) —
  host assembly between Studio dispatch and direct Pet conversation.
- [Configuration](configuration.md) — `studio.json`, per-pet files, validation,
  and Plugin injection.
- [Studio API reference](../reference/api/studio.md) — exported TypeScript
  types and exact method semantics.
- [Channel design](../design/studio/channel-addressing-and-execution.md) — current
  message, session, source and queue-observation semantics.
- [HTTP Plugin design](../design/studio/http-plugin.md) — the single HTTP/SSE
  control plane and contributed-route boundary.

## Ownership and limits

Studio validates the live registry and entryPetId, admits dispatch and allocates
invocation identities, starts/stops Plugins and broadcasts their events.
Resident runtime owns queue/gate, conversation, checkpoints and session recovery.
Plugins own domain history, scheduling, trigger policy and knowledge projection.
In-memory admission records and live events do not provide execution results,
automatic retry, timeout or durable replay. Exact contracts live in the API reference.

Channel owns goals, public messages and fixed Channel/Pet bindings. Its single
[current design](../design/studio/channel-addressing-and-execution.md) covers
participant addressing, default Reply, trusted source and observation limits.
Scheduler/Trigger remain independent Plugins; [queue auditing](../design/studio-dispatch-queue-notices.md)
is an opt-in policy, not Channel queue ownership.

The HTTP Plugin provides the authenticated control plane through dispatch/events
and contributed domain routes. A separate Host Pet listener provides Agent Session
HTTP/SSE and WebSocket conversation, without entering Studio core.

Earlier designs and milestones are retained in [Studio history](../history/index.md).
Workdir initialization does not upgrade existing projects; use the explicit
[configuration migration guide](configuration.md#retired-kanban-workdirs).
