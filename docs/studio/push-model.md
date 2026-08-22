# Studio Push Model

[简体中文](../zh-CN/studio/push-model.md)

> **Status: current contract.** The source of truth is
> [`studioContract.ts`](../../packages/studio/src/studioContract.ts),
> [`studioInvocation.ts`](../../packages/studio/src/studioInvocation.ts), and
> [`createStudio.ts`](../../packages/studio/src/createStudio.ts).

Studio is a plugboard between Plugins and resident Pet runtimes. It provides a
typed dispatch channel and a separate generic event bus:

```text
Plugin ── dispatch(input) ──> Studio ── serialized invocation ──> Pet thread
Plugin ── notify(event)  ──> Studio ── fan-out ────────────────> Plugins
```

Studio does not define task schemas, dependencies, scheduling, retries, or
Plugin persistence. Plugin is a higher-level extension that may define Agent
Toolkits; it is not itself a Toolkit. Capability remains entirely Agent-owned.

## Dispatch, thread, and invocation

```ts
const receipt = await studio.dispatch({
  petId: 'writer',
  input: { kind: 'request', request: 'Draft the article.' },
  metadata: { producerRef: 'external-job-42' },
});

const result = await receipt.completion;

const unsubscribe = receipt.onInvocation((event) => {
  // Observe only this invocation; the latest state is replayed on subscribe.
});
```

Acceptance returns immediately. Every resident Pet owns one deterministic,
durable thread derived from `(studioId, petId)`. Every accepted dispatch creates
a separate invocation on that thread. This distinguishes continuity from work:

- `threadId` is stable across dispatches and Host restarts;
- `invocationId` identifies one accepted call;
- `interruptId` identifies the current resumable checkpoint wait;
- external producers may keep their own correlation references in opaque
  `metadata`; Studio echoes them on receipts/events but never passes them into
  the Pet runtime.

One Pet executes at most one active invocation at a time; different Pets may
execute concurrently. A receipt's `completion` settles as `completed`,
`pending_interrupt`, `failed`, or `cancelled`. An explicit `idempotencyKey`
deduplicates retries for one Pet within the current Host generation.

Studio rejects acceptance when it is shut down, the Pet is unknown or disabled,
or the dispatch envelope is invalid. Runtime failures settle the accepted
invocation as `failed` rather than turning acceptance into a long-running RPC.

## Durable interrupt and resume

A checkpointed interrupt ends the current invocation but not the Pet thread:

```text
request invocation A1 ──> pending_interrupt(interrupt-7)
resume invocation  A2 ──> same Pet thread ──> completed
```

The pending result/event contains a presentation-safe projection. An interaction
Plugin or Host adapter may show it to a user and later submit:

```ts
await studio.dispatch({
  petId: 'writer',
  input: {
    kind: 'resume_interrupt',
    interruptId: 'interrupt-7',
    payload: {
      kind: 'human_review_response',
      responses: [{ interactionId: 'review-1', selectedOptionId: 'approve' }],
    },
  },
});
```

Studio core carries this typed value but does not interpret review options or
construct graph commands. The Pet runtime reads the authoritative checkpoint,
validates the interrupt and responses, and resumes LangGraph. A stale interrupt
fails without changing the checkpoint. No Chat session, route cache, or review
message is reused.

`receipt.onInvocation()` observes one accepted invocation and immediately
replays its latest known state. This is the request transport's correlation
boundary: no private route identity is added to producer metadata. The public
Studio `onInvocation()` remains the live Host-wide observation, while a Plugin
context sees only invocations it dispatched. Events carry Pet/thread/invocation
identity and opaque metadata. They are not durable; checkpoint state, not an
event subscriber, owns interrupt existence.

## Independent event bus

```ts
context.notify({
  type: 'task.completed',
  metadata: { taskId: 'task-42' },
  payload: { summary: 'Draft saved.' },
});
```

Studio fills `source` and `occurredAt` for Plugin events, then asynchronously
fans them out. It does not validate payload meaning, persist or replay events,
infer that an event completes a dispatch, or attach a global Plugin event to a
transport delivery. Dispatch observation belongs to receipt/Studio
`onInvocation`; domain notification belongs to `notify`/`subscribe`.

## Plugin and Toolkit boundary

```ts
type StudioPlugin = {
  name: string;
  toolkits: readonly AgentToolkit[];
  start(context: StudioPluginContext): Promise<void> | void;
  stop?(): Promise<void> | void;
};
```

Plugin Toolkits enter the Host inventory before resident Pets are built.
Capability definitions are loaded for each Pet by the Agent Host and select
Toolkits through `Capability.uses`; Studio and Plugins do not register or attach
Capabilities. A Plugin may define zero Toolkits when it only drives dispatch or
events.

Studio starts Plugins in order and stops them in reverse. A startup failure
rolls back the started prefix. `listPets()` returns descriptors, never runtime
references, so Plugin-originated work stays on the shared dispatch boundary.

## Boundary checklist

| Studio | Plugin, Pet runtime, or Host |
|---|---|
| Pet registry and dispatch validity | Task schema, dependencies, scheduling, retries |
| Stable Pet thread and per-Pet invocation serialization | Checkpoint interpretation and resume command |
| Invocation identity and live observation | Interaction UI, authorization, durable pending index |
| Opaque event fan-out | Event meaning and durable delivery |
| Plugin lifecycle | Plugin state and persistence |

Current deliberate limits include in-memory invocation queues and idempotency
records, no backpressure, no durable event replay, and no bundled interaction
Plugin. The Pet checkpoint remains durable independently of those limits.
