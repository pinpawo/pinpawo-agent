# Studio API

> Status: current contract. The public API is exported by
> [`@pinpawo/studio`](../../../packages/studio/src/index.ts).

Studio is a small one-way dispatch and Plugin-event substrate. It receives only
Pet registration metadata and `PetDispatchPort`; it does not receive Agent
Session, checkpoint, Capability inventory, or private actor data.

```ts
type StudioPetBinding = {
  registration: {
    petId: string;
    name: string;
    role?: string | null;
    serviceSummary?: string | null;
  };
  dispatch: PetDispatchPort;
};

type StudioDispatchRequest = {
  petId: string;
  request: string;
  metadata?: JsonObject;
  idempotencyKey?: string;
};
```

`Studio.dispatch()` validates the live Pet, allocates an `invocationId`, and
returns an admission receipt after the resident dispatch port accepts the input.
The receipt has no completion, execution status, output, error, or cancellation
handle. Queueing and the dispatch gate belong to the resident runtime; execution
is observed through Agent Session events, checkpoints, or Plugin-owned domain
state rather than a Studio result.

Plugins receive only `dispatch`, `notify`, `subscribe`, `listPets`, and Plugin
hook installation. A Plugin may define Toolkits, but it cannot construct a Pet,
inspect a runtime, or participate in Agent Session conversation.

`StudioHost` eagerly builds every configured Pet. Any Pet startup failure rolls
the whole Host back. `startStudioHost()` also starts the local-agent Pet-scoped
Agent Session listener. Configured HTTP Plugins provide the Studio control plane;
Studio has no built-in WebSocket or stdio dispatch protocol.
