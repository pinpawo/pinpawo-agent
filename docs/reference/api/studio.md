# Studio API

[简体中文](../../zh-CN/reference/api/studio.md)

> **Status: current programming contract.** The authoritative exports are in
> [`packages/studio/src/index.ts`](../../../packages/studio/src/index.ts),
> [`studioContract.ts`](../../../packages/studio/src/studioContract.ts),
> [`studioInvocation.ts`](../../../packages/studio/src/studioInvocation.ts), and
> [`types.ts`](../../../packages/studio/src/types.ts).
>
> **Accepted target delta:** typed dispatch resume, fixed per-Pet `threadId`,
> lazy/disabled registrations and the built-in Studio WebSocket/stdio transport
> are transitional. The target is defined by
> [Resident Pet Host Ports](../../design/agent-runtime/resident-pet-host-ports.md).

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
  listPets(): StudioPetRegistration[];
  shutdown(): Promise<void>;
};

type StudioDispatchRequest = {
  petId: string;
  input:
    | { kind: 'request'; request: string }
    | { kind: 'resume'; continuationId: string; payload: JsonObject };
  metadata?: JsonObject;
  idempotencyKey?: string;
  signal?: AbortSignal;
};

type StudioDispatchReceipt = {
  petId: string;
  threadId: string;
  invocationId: string;
  metadata?: JsonObject;
  onInvocation(handler: StudioInvocationEventHandler): () => void;
  completion: Promise<StudioDispatchResult>;
};

type StudioDispatchResult = {
  petId: string;
  threadId: string;
  invocationId: string;
  status: 'completed' | 'waiting' | 'failed' | 'cancelled';
  metadata?: JsonObject;
  output?: string;
  pendingContinuation?: PendingContinuationProjection;
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
Its `onInvocation()` observer is scoped to this invocation and immediately
replays the latest known event, so transport adapters can acknowledge first and
still observe progress that raced receipt delivery.

One Pet executes at most one invocation at a time. A durable continuation
settles the current invocation as `waiting` and releases the queue slot. A later
typed resume creates a different invocation on the same Pet thread. The Pet
runtime validates the continuation against its authoritative checkpoint; a stale
resume fails without mutating it.

Producer `metadata` is opaque and is copied into receipts, results, and
invocation events. It never replaces Studio, Pet, thread, invocation, or
interrupt identity. An `idempotencyKey` is scoped to one Pet and retained for
the current Host generation.

`notify()` fans a complete event out to current subscribers. Notification
handlers run asynchronously; an error in one is isolated from the publisher and
other subscribers. The API does not persist, replay, validate, or correlate
event payloads.

Receipt `onInvocation()` is the correlation-safe observer for one accepted
dispatch. Studio-level `onInvocation()` is the Host control subscription. It
observes `busy` and terminal events for direct Host and Plugin dispatches.
Unlike the generic event bus, both are execution observation channels with
explicit Pet/thread/invocation identity. They are in-memory; only the receipt
observer replays its latest event.

`listPets()` returns the Studio Pet registry only, not runtime references or
Agent-private actor fields. Each registration contains `petId`, `name`,
`role`, `serviceSummary`, `startupMode`, `status`, and the public Capability
summary. This keeps all work on the dispatch boundary while allowing a control
client to discover valid dispatch targets.

### Transport-neutral dispatch parsing

`parseStudioDispatchRequest(value)` validates the JSON representation of a
`StudioDispatchRequest`. It accepts `petId`, typed request/resume input,
JSON-compatible `metadata`, and `idempotencyKey`, while deliberately excluding
the process-local `AbortSignal`. Studio wire transport and the optional
[HTTP Plugin](../../studio/http-plugin.md) use the same parser, so transport
adapters do not define competing dispatch shapes.

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
  listPets(): StudioPetRegistration[];
  hooks: StudioPluginHooks;
};
```

The context assigns the Plugin's `source` and event timestamp. Its invocation
handler sees only dispatches initiated by that Plugin:

```ts
type StudioInvocationEvent = {
  petId: string;
  threadId: string;
  invocationId: string;
  status: 'busy' | 'completed' | 'waiting' | 'failed' | 'cancelled';
  metadata?: JsonObject;
  output?: string;
  pendingContinuation?: PendingContinuationProjection;
  error?: string;
};
```

The callback is a live projection of the same result lifecycle. The durable
source of interrupt existence remains the Pet checkpoint, not this callback.

`hooks` is the opaque Plugin-to-Plugin composition channel. A provider calls
`expose(name, hook)` and a contributor calls
`contribute(targetPluginName, hookName, install)`. Contributions attach in
either Plugin start order and are removed with either side's lifecycle. Studio
matches identities and owns cleanup, but never interprets the hook value. For
example, the HTTP Plugin exposes `routes`, and Kanban can contribute a board
route without HTTP importing Kanban.

If plugin startup fails, Studio calls `stop()` in reverse order for every
plugin that may have started, including the plugin whose `start()` rejected.
After shutdown, queued dispatches that have not begun are discarded rather
than invoking a pet after plugin listeners have stopped.

## Pet runtime port

A host currently supplies runnable pets through this transitional dispatch
adapter:

```ts
type PetAgentRuntime = {
  descriptor(): PetAgentRuntimeDescriptor;
  invoke(input: PetAgentRuntimeInvokeInput): Promise<
    | { status: 'completed'; reply: string }
    | { status: 'waiting'; pendingContinuation: PendingContinuationProjection }
  >;
  gate(): 'open' | 'busy' | 'waiting' | 'blocked';
  onGateChange(listener: (state: PetGateState) => void): () => void;
  shutdown?(): Promise<void>;
};
```

Despite its current name, this is not the complete external surface of a
resident Pet. The accepted target contract is local-agent's
[`ResidentPetHost`](../../design/agent-runtime/resident-pet-host-ports.md),
which composes an independently built `ResidentPet` and
`ResidentPetInteraction`. Studio receives only `PetDispatchPort`; the
interaction adapter directly reuses Agent Session and stays outside
`@pinpawo/studio`. In that target, dispatch contains only a request, resolves
the active thread internally at execution time, and cannot resume a pending
continuation.

The invocation input carries only the typed request/resume, resolved stable
`threadId`, and cancellation signal. Invocation identity remains in Studio's
coordination and observation envelope; it is not Pet graph input. Capability,
Toolkit, workdir, and Agent execution context are fixed when the Host builds the
resident Pet; Studio cannot inject them per dispatch. The runtime owns
checkpoint interpretation and resume validation. `gate()` is retained as a
Host diagnostic; Studio does not keep an invocation alive or block its queue on
`waiting`. The local adapter is documented in [Pet Runtime API](pet-runtime.md).

## Configuration exports

`@pinpawo/studio` also exports `studioLocalConfigSchema`,
`petLocalConfigSchema`, and `resolveStudio()`. File paths and plugin factory
selection are intentionally local-host concerns; see
[Studio configuration](../../studio/configuration.md).
