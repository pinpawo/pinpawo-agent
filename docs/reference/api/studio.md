# Studio API

[简体中文](../../zh-CN/reference/api/studio.md)

> **Status: current programming contract.** The authoritative exports are in
> [`packages/studio/src/index.ts`](../../../packages/studio/src/index.ts),
> [`studioContract.ts`](../../../packages/studio/src/studioContract.ts), and
> [`types.ts`](../../../packages/studio/src/types.ts).

Studio is a lightweight multi-pet dispatch substrate. It does not expose runs,
task snapshots, cancellation, retries, result aggregation, a scheduler, or
shared-wiki APIs.

## Constructing Studio

```ts
import { createStudio } from '@pinpawo/studio';

const studio = await createStudio({
  studioId: 'content-studio',
  entryPetId: 'planner',
  pets: [plannerRuntime, writerRuntime],
  plugins: [kanbanPlugin],
});
```

`createStudio()` rejects duplicate runtime `petId` values and an `entryPetId`
that is absent from `pets`. It starts plugin hooks in supplied order; a failed
plugin start rejects construction.

## Public surface

```ts
type Studio = {
  entryPetId: string;
  dispatch(input: StudioDispatchRequest): Promise<StudioDispatchReceipt>;
  onInvocation(handler: StudioInvocationEventHandler): () => void;
  notify(event: StudioEvent): void;
  subscribe(handler: StudioEventHandler): () => void;
  listPets(): PetAgentRuntimeDescriptor[];
  shutdown(): Promise<void>;
};

type StudioDispatchRequest = {
  petId: string;
  input:
    | { kind: 'request'; request: string }
    | {
        kind: 'resume_interrupt';
        interruptId: string;
        payload: {
          kind: 'human_review_response';
          responses: HumanReviewResponse[];
        };
      };
  metadata?: JsonObject;
  idempotencyKey?: string;
  signal?: AbortSignal;
};

type StudioDispatchReceipt = {
  petId: string;
  threadId: string;
  invocationId: string;
  metadata?: JsonObject;
  completion: Promise<StudioDispatchResult>;
};

type StudioDispatchResult = {
  petId: string;
  threadId: string;
  invocationId: string;
  status: 'completed' | 'pending_interrupt' | 'failed' | 'cancelled';
  metadata?: JsonObject;
  output?: string;
  pendingInterrupt?: PendingInterruptProjection;
  error?: string;
};

type StudioEvent = {
  type: string;
  source: string;
  metadata?: JsonObject;
  payload?: unknown;
  occurredAt: string;
};
```

`dispatch()` accepts delivery to a configured, non-disabled Pet and immediately
returns a receipt. `threadId` is stable for the `(studioId, petId)` pair;
`invocationId` is new for every accepted call unless an explicit
`idempotencyKey` finds an existing call. Acceptance does not mean the graph work
has completed. The receipt's `completion` promise settles with a terminal result.

One Pet executes at most one invocation at a time. A durable interrupt settles
the current invocation as `pending_interrupt` and releases the queue slot. A
later typed resume creates a different invocation on the same Pet thread. The
Pet runtime validates the interrupt against its authoritative checkpoint; a
stale resume fails without mutating it.

Producer `metadata` is opaque and is copied into receipts, results, and
invocation events. It never replaces Studio, Pet, thread, invocation, or
interrupt identity. An `idempotencyKey` is scoped to one Pet and retained for
the current Host generation.

`notify()` fans a complete event out to current subscribers. Notification
handlers run asynchronously; an error in one is isolated from the publisher and
other subscribers. The API does not persist, replay, validate, or correlate
event payloads.

`onInvocation()` is the Host control subscription. It observes `busy` and
terminal events for direct Host and Plugin dispatches. Unlike the generic event
bus, it is an execution observation channel with explicit Pet/thread/invocation
identity. It is in-memory and has no replay guarantee.

`listPets()` returns descriptors only, not runtime references. This keeps all
plugin-originated work on the dispatch boundary.

## Plugin context

A Studio Plugin is a higher-level extension, not an `AgentToolkit`. It defines
zero or more Agent Toolkits through `toolkits` and has a required Studio
lifecycle entry:

```ts
type StudioPlugin = {
  name: string;
  toolkits: readonly AgentToolkit[];
  start(context: StudioPluginContext): Promise<void> | void;
  stop?(): Promise<void> | void;
};
```

Plugin-defined Toolkits enter the Host inventory before Pet construction.
Capabilities remain Agent-owned and are never registered by Studio Plugins.
The local Studio Host derives each Pet's definitions and selection from
`pets/<petId>/capabilities/<capability>/CAPABILITY.md`; the Pet JSON contains no
Capability name list.
When a Plugin starts, it receives this context:

```ts
type StudioPluginContext = {
  dispatch(input: StudioDispatchRequest): Promise<StudioDispatchReceipt>;
  onInvocation(handler: StudioInvocationEventHandler): () => void;
  notify(event: StudioEventInput): void;
  subscribe(handler: StudioEventHandler): () => void;
  listPets(): PetAgentRuntimeDescriptor[];
};
```

The context assigns the Plugin's `source` and event timestamp. Its invocation
handler sees only dispatches initiated by that Plugin:

```ts
type StudioInvocationEvent = {
  petId: string;
  threadId: string;
  invocationId: string;
  status: 'busy' | 'completed' | 'pending_interrupt' | 'failed' | 'cancelled';
  metadata?: JsonObject;
  output?: string;
  pendingInterrupt?: PendingInterruptProjection;
  error?: string;
};
```

The callback is a live projection of the same result lifecycle. The durable
source of interrupt existence remains the Pet checkpoint, not this callback.

If plugin startup fails, Studio calls `stop()` in reverse order for every
plugin that may have started, including the plugin whose `start()` rejected.
After shutdown, queued dispatches that have not begun are discarded rather
than invoking a pet after plugin listeners have stopped.

## Pet runtime port

A host supplies the runnable pets:

```ts
type PetAgentRuntime = {
  descriptor(): PetAgentRuntimeDescriptor;
  invoke(input: PetAgentRuntimeInvokeInput): Promise<
    | { status: 'completed'; reply: string }
    | { status: 'pending_interrupt'; pendingInterrupt: PendingInterruptProjection }
  >;
  gate(): 'open' | 'busy' | 'waiting' | 'blocked';
  onGateChange(listener: (state: PetGateState) => void): () => void;
  shutdown?(): Promise<void>;
};
```

The invocation input carries the typed request/resume, resolved stable
`threadId`, current `invocationId`, and opaque metadata. The runtime owns
checkpoint interpretation and resume validation. `gate()` is retained as a
Host diagnostic; Studio does not keep an invocation alive or block its queue on
`waiting`. The local adapter is documented in [Pet Runtime API](pet-runtime.md).

## Configuration exports

`@pinpawo/studio` also exports `studioLocalConfigSchema`,
`petLocalConfigSchema`, and `resolveStudio()`. File paths and plugin factory
selection are intentionally local-host concerns; see
[Studio configuration](../../studio/configuration.md).
