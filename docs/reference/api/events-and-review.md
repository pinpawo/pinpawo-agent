# Events and Human Review API

> **Status: current contract.** Review payload types live in
> [`packages/pet-agent/src/types/reviewSpec.ts`](../../../packages/pet-agent/src/types/reviewSpec.ts).
> Root tool-event normalization is implemented by
> [`SubagentProtocolToolEventReader`](../../../packages/pet-agent/src/subagent/protocolToolEvents.ts)
> and runtime notices are emitted through
> [`streamWriterEvents.ts`](../../../packages/pet-agent/src/utils/streamWriterEvents.ts).

There are two intentionally separate observability paths:

1. **Studio Plugin events** carry producer-defined notifications and Studio
   boundary facts. A dispatch acceptance is not an execution result; see the
   [Studio contract](../api/studio.md).
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

## Host operation events

The Host normalizes tool lifecycle events to
[`AgentOperationEvent`](../../../packages/agent-session/src/events.ts), including
operation metadata and an optional `raw` object with tool input, output, and
errors. Toolkit authors can provide a pure input `summarize` function in the
[Toolkit contract](../extensions/capability-toolkit.md); clients can use the
summary and blocks for stable display. See the
[operation summary design](../../design/host/operation-summary.md) for details.

Raw tool data can contain sensitive user or environment information. Local Host
transports preserve native events; any adapter exposing them beyond its trust
boundary must apply its own disclosure policy. Summaries are display projections,
not a guarantee that the contents are safe to disclose.

## Human review boundary

A tool review can interrupt execution with a single review or ordered review
batch. The Host exposes the pending interrupt from the checkpoint through the
session projection. A client sends `interrupt.resume` with the pending interrupt
and review decisions; the Host validates the response and resumes the checkpoint
so the Runtime can apply the decision. Rejection or cancellation ends the current
round.
See [Session projection](../runtime/session-projection.md#shape) for pending
interrupts and continuation, and the [Studio API](studio.md#exact-pet-session-observation-and-review)
for exact-session review over HTTP.

An integration should keep a review scoped to its session, avoid inventing a
second approval state machine, and treat an interrupted tool as pending review
rather than failed work. See [Authorization matcher](../runtime/authorization-matcher.md)
for durable per-session authorization reuse.
