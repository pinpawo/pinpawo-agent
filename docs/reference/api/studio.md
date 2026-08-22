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
  dispatch(input: StudioDispatchInput): Promise<StudioDispatchResult>;
  onDispatchGate(handler: StudioDispatchGateHandler): () => void;
  notify(event: StudioEvent): void;
  subscribe(handler: StudioEventHandler): () => void;
  listPets(): PetAgentRuntimeDescriptor[];
  shutdown(): Promise<void>;
};

type StudioDispatchInput = {
  petId: string;
  request: string;
  correlationId?: string;
  signal?: AbortSignal;
};

type StudioDispatchResult = { threadId: string };

type StudioEvent = {
  type: string;
  source: string;
  correlationId?: string;
  payload?: unknown;
  occurredAt: string;
};
```

`dispatch()` accepts delivery to a configured, non-disabled pet and returns a
new `threadId` immediately. It queues the runtime invocation and does not mean
that work has completed. It throws only when Studio has shut down, the pet is
unknown, or the pet is disabled. A busy pet is queued, not rejected.

`notify()` fans a complete event out to current subscribers. Notification
handlers run asynchronously; an error in one is isolated from the publisher and
other subscribers. The API does not persist, replay, validate, or correlate
event payloads.

`onDispatchGate()` is the Host control subscription. Unlike the plugin-scoped
callback below, it observes direct Host dispatches as well as plugin dispatches.
It is intended for a transport to project gate state and release its request
correlation when work reaches `open` or `blocked`.

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
  dispatch(input: StudioDispatchInput): Promise<StudioDispatchResult>;
  onDispatchGate(handler: StudioDispatchGateHandler): () => void;
  notify(event: StudioEventInput): void;
  subscribe(handler: StudioEventHandler): () => void;
  listPets(): PetAgentRuntimeDescriptor[];
};
```

The context assigns the plugin's `source` and the event timestamp. Its gate
handler sees changes only for dispatches initiated by that plugin:

```ts
type StudioDispatchGateChange = {
  threadId: string;
  petId: string;
  correlationId?: string;
  state: 'open' | 'busy' | 'waiting' | 'blocked';
};
```

The callback is a progress signal. It is not a result channel and has no
durability or replay guarantee.

If plugin startup fails, Studio calls `stop()` in reverse order for every
plugin that may have started, including the plugin whose `start()` rejected.
After shutdown, queued dispatches that have not begun are discarded rather
than invoking a pet after plugin listeners have stopped.

## Pet runtime port

A host supplies the runnable pets:

```ts
type PetAgentRuntime = {
  descriptor(): PetAgentRuntimeDescriptor;
  invoke(input: PetAgentRuntimeInvokeInput): Promise<{ reply: string }>;
  gate(): 'open' | 'busy' | 'waiting' | 'blocked';
  onGateChange(listener: (state: PetGateState) => void): () => void;
  shutdown?(): Promise<void>;
};
```

Studio uses `gate()` and `onGateChange()` to protect its per-pet queue. A
runtime must signal `open` after any pending continuation is actually complete.
The local adapter is documented in [Pet Runtime API](pet-runtime.md).

## Configuration exports

`@pinpawo/studio` also exports `studioLocalConfigSchema`,
`petLocalConfigSchema`, and `resolveStudio()`. File paths and plugin factory
selection are intentionally local-host concerns; see
[Studio configuration](../../studio/configuration.md).
