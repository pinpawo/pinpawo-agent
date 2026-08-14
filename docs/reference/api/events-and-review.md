# Events and Human Review API

> **Status: current contract.** Review port types live in
> [`packages/studio/src/types.ts`](../../../packages/studio/src/types.ts).
> Root tool-event normalization is implemented by
> [`SubagentProtocolToolEventReader`](../../../packages/pet-agent/src/subagent/protocolToolEvents.ts)
> and runtime notices are emitted through
> [`streamWriterEvents.ts`](../../../packages/pet-agent/src/utils/streamWriterEvents.ts).

There are two intentionally separate observability paths:

1. **Studio orchestration events** report run and task progress. Consume
   `StudioRunEvent` or the optional `onTurnEvent` callback when building a
   queue, status, or task-progress view.
2. **Root stream events** carry Pet-internal operation detail. Local hosts
   normalize the LangGraph `tools` protocol channel into tool lifecycle events;
   runtime notices appear on the `custom` channel.

Do not infer durable session state from either stream. A client restores durable
state through [Session projection](../runtime/session-projection.md).

## Tool lifecycle events

The normalized shape is:

```ts
type SubagentToolLifecycleEvent =
  | { event: 'on_tool_start'; toolCallId?: string; name: string; input: unknown }
  | { event: 'on_tool_event'; toolCallId?: string; name: string; data: unknown }
  | { event: 'on_tool_end'; toolCallId?: string; name: string; output: unknown }
  | { event: 'on_tool_error'; toolCallId?: string; name: string; error: unknown };

type SubagentRuntimeEvent = {
  event: 'on_runtime_event';
  name: string;
  data: unknown;
};
```

The reader preserves tool identity across start, delta, finish, and error
events; it de-duplicates repeated protocol events. A serialized review
interrupt is not reported as a tool failure because its state is represented by
the review boundary below.

## Human review boundary

```ts
type HumanReviewer = (
  request: HumanReviewInterruptPayload,
) => Promise<ReviewResponse>;
```

The local host supplies this callback when it creates a Pet runtime. It routes a
canonical review request to the appropriate client, waits for one canonical
`ReviewResponse`, then resumes or stops the graph. The caller of `invoke()`
sees an atomic Promise rather than an additional review callback.

An integration should keep a review request scoped to its run/session, avoid
inventing a second approval state machine, and treat an interrupted tool as
pending review rather than failed work. See [Authorization matcher](../runtime/authorization-matcher.md)
for durable per-session authorization reuse.
