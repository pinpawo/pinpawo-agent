# Studio Push Model

[简体中文](../zh-CN/studio/push-model.md)

> **Status: current contract.** The source of truth is
> [`studioContract.ts`](../../packages/studio/src/studioContract.ts) and
> [`createStudio.ts`](../../packages/studio/src/createStudio.ts).

Studio is a plugboard between plugins and Pet runtimes. It exposes two
independent one-way channels:

```text
plugin ── notify(event) ──> Studio ── dispatch(request) ──> pet
```

It neither interprets an event nor treats an event as the result of a dispatch.
A plugin may publish no events for a dispatch, many events, or events unrelated
to dispatch entirely. `correlationId` is a plugin-owned value that Studio only
passes through.

## Dispatch is acceptance, not completion

```ts
const { threadId } = await studio.dispatch({
  petId: 'writer',
  request: 'Draft the article.',
  correlationId: 'task-42',
});
```

The returned `threadId` identifies the accepted delivery. Studio rejects only
three cases: it has shut down, the `petId` is unknown, or the target pet has
`startupMode: 'disabled'`. A busy pet is not rejected; the request is queued.

Studio does not wait for a reply, expose a run snapshot, infer success, retry,
or correlate a reply with an event. If `invoke()` rejects, Studio records the
failure and leaves the runtime gate to prevent unsafe follow-up work. Result
storage and recovery rules belong to the dispatching plugin.

## Per-pet queue and runtime gate

Each pet has one FIFO queue. Different pets may execute concurrently, but one
pet receives its next request only after its gate is open:

| Gate | Meaning | Queue behavior |
|---|---|---|
| `open` | The pet has no unfinished continuation. | Deliver the next request. |
| `busy` | The runtime is executing. | Keep the queue closed; it may recover itself. |
| `waiting` | The runtime is waiting for external input. | Keep the queue closed until the runtime signals `open`. |
| `blocked` | The preceding dispatch failed or could not proceed. | Keep the queue closed for human intervention. |

`invoke()` resolving is not sufficient to release the queue: a checkpointed
runtime may return while it awaits human review. Studio only observes the gate;
it does not offer a control plane for opening it. A host/runtime integration
must ensure that a resumed pet eventually reports `open`.

The current local Studio transport has no built-in review UI, but the Pet runtime
still declares `humanReview: true`. LangGraph persists the interrupt and the gate
may remain `waiting` indefinitely. A separate Studio plugin or Host adapter may
project the pending action to an interaction layer and resume the same thread;
Studio core does not need to understand review.

Plugins can subscribe with `onDispatchGate()` to changes for dispatches they
initiated. This is point-to-point feedback, not a broadcast event. Host-issued
dispatches are observable through the public `Studio.onDispatchGate()` control
subscription without exposing them to unrelated plugins.

## Event bus

Plugins use their context to publish:

```ts
context.notify({
  type: 'task.completed',
  correlationId: 'task-42',
  payload: { summary: 'Draft saved.' },
});
```

Studio fills `source` from the plugin name and supplies `occurredAt`. It fans
the notification out asynchronously to subscribers. A failing subscriber is
logged and does not affect the publisher or other subscribers. The public
`Studio.notify()` / `subscribe()` methods also support a host event bridge, but
a host must provide complete `StudioEvent` values itself.

The bus is neither durable nor replayable. It has no delivery guarantee across
process restarts and must not be used as the source of truth for plugin state.

## Plugins have two optional faces

A `StudioPlugin` extends `AgentToolkit`:

```ts
type StudioPlugin = AgentToolkit & {
  studio?: {
    start(context: StudioPluginContext): Promise<void> | void;
    stop?(): Promise<void> | void;
  };
};
```

The Toolkit face lets a pet read or modify the plugin's domain state. The
Studio face lets that same component dispatch work and publish notifications.
Either face may be omitted. Studio starts plugin faces in configuration order;
if a start operation fails, construction fails. It stops them in reverse order
and isolates stop failures while cleaning subscriptions.

The bundled `kanban` plugin illustrates the loop:

```text
pet → kanban_task_* Toolkit → Kanban board → plugin dispatch / notification
```

Studio remains unaware of task IDs, dependencies, board status, and task
results throughout that loop.

## Boundary checklist

Put a concern in Studio only when it is necessary for the shared channel:

| Studio | Plugin or host |
|---|---|
| Pet registry, dispatch validity, per-pet serialization | Task schema, dependencies, progress, retries, and persistence |
| Runtime-gate observation | How a pet is resumed or a blocked task is resolved |
| Event fan-out | Event payload meaning and durable delivery |
| Plugin lifecycle | Scheduling, webhooks, transports, UI, and auth |

Current deliberate limits are in-memory queues, no backpressure, no terminal
dispatch result, no automatic retry, and no plugin-state persistence convention.
Those are not hidden behavior; integrations that require them must model them
explicitly at their own boundary.
