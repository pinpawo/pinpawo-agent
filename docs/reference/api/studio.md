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

After admission, Studio publishes a live `dispatch.accepted` event with the
`invocationId`, target `petId`, request text, and producer name. This is an
observability fact on the same non-durable event bus, not a completion signal or
a dispatch result store. Idempotent replay returns the original receipt without
publishing another accepted event. Simultaneous submissions share the pending
admission Promise. Keys are scoped to producer and Pet; a failed admission releases
the process-local reservation. This is not a durable replay or exactly-once guarantee.

Plugins receive `dispatch`, `notify`, `subscribe`, `listPets`, `listDispatchQueues`, and Plugin
hook installation. A Plugin may define Toolkits, but it cannot construct a Pet,
inspect a runtime, or participate in Agent Session conversation.

## Global dispatch observation

The Studio HTTP Plugin exposes `GET /dispatch/queues` under the existing Studio
Bearer authority. It forwards each resident Pet's actual global admission snapshot:
state, active operation, queue counts, and optional active / queued dispatch identities.
Queue entries include dispatch ID, enqueue time, and admitted session / scope
correlation, with no request text or model content. Conversation holds are counts,
not a second dispatch queue. This read-only endpoint neither schedules nor restores work.

## Channel messages and addressing

The Channel Plugin supplies `GET /channels/participants` and participants in Channel
context. A participant has a unique `participantId`, label, existing identity and
response adapter kind. The configured local operator and Pets share one protocol;
the viewer identity affects the display label only.

`POST /channels/messages` accepts a body, optional replyTo, artifacts and
`mentions: [{participantId}]`. A direct Markdown mention
`[@label](participant:pet:reviewer)` carries the same unique identity; labels never
route requests. Plain `@label`, code and quoted examples do not address a target.
Channel validates and saves the message, then calls dispatch for each Pet target
using that target's fixed Channel session. Human targets read and respond in the UI.
The response retains the message fields and includes per-target delivery receipts
or admission failures; execution completion is observed separately.

Host-authenticated Pet completed replies enter this same addressing path. Pets
choose whether to @ according to Capability instructions. replyTo is context and
does not choose the unified message recipient. The old `/channels/execute` action
remains compatible, including its replyTo-only original-session action.

Per-target execution observations and failures remain available through
`GET /channels/executions`; they are not an authoritative queue or reliability engine.

`StudioHost` eagerly builds every configured Pet. Any Pet startup failure rolls
the whole Host back. `startStudioHost()` also starts the host Pet-scoped
Agent Session listener. Configured HTTP Plugins provide the Studio control plane;
Studio has no built-in WebSocket or stdio dispatch protocol.

## Host Agent Session HTTP

The host listener also exposes HTTP/SSE alongside its WebSocket, on the
Pet port (default `3212`). This is separate from the Studio HTTP Plugin (`3211`).
All routes require the existing Bearer token; they share the WebSocket Origin
policy, protocol parser and runtime handlers.

| Route | Result |
| --- | --- |
| `GET /agent-session/pets/:petId/snapshot` | Existing `session.snapshot.result` envelope plus `queue` state |
| `GET /agent-session/pets/:petId/events` | Live SSE, `event: message`, JSON `AgentServerMessage` data |
| `POST /agent-session/pets/:petId/messages` | Existing `AgentClientMessage` with `requestId`; JSON body, 1 MiB limit; `202 {requestId}` |

HTTP commands and SSE readers do not claim the exclusive TUI connection. The
Host owns submitted commands, so disconnecting HTTP/SSE does not stop execution.
To resolve review, read the snapshot and send `interrupt.resume` with its
interrupt ID and the kind-owned decision value. The runtime validates the same
IDs and decisions used by the TUI. `run.interrupt` targets a run by request ID
across HTTP, TUI and dispatch.

202 is acceptance, not completion. Events have no persistent replay; subscribe
before sending commands and reread the snapshot after reconnecting. Do not
blindly resubmit accepted mutations. Legacy `new_session` without a request ID
is not an HTTP command; use the current `session.new` protocol instead.

The repository's [Studio skill](../../../skills/studio/SKILL.md) includes a
standard-library client for these endpoints and Studio dispatch.
