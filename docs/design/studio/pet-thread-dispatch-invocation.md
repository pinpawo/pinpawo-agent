# Studio Pet Thread and Dispatch Invocation

> Status: Implemented draft
> Date: 2026-08-22
> Implemented: 2026-08-23
> Related: issue #684, PR #682, issues #561 and #675
> Shared interrupt contract: [Pending Interrupt in Chat](../local-agent/pending-interrupt-chat.md)

## Decision summary

Studio dispatches work to a Pet. Each resident Pet owns one durable graph
thread, and every dispatch call creates one serialized invocation on that
thread.

```text
Studio
├─ Pet A ── thread A
│          ├─ dispatch(request)          -> invocation A1 -> complete
│          ├─ dispatch(request)          -> invocation A2 -> waiting continuation
│          └─ dispatch(resume)           -> invocation A3 -> resume -> complete
├─ Pet B ── thread B
└─ Pet C ── thread C
```

The continuation ends invocation A2, not thread A. A later dispatch may carry the
Pet-defined input that resumes it. Dispatch producers are opaque; their
origin does not change routing or checkpoint semantics.

## Boundary with Chat

PR #682 optimizes the current Chat adapter. Chat has an implicit active session
and thread, uses no Studio dispatch, and needs no `petId` in its interrupt
projection.

Studio does not reuse Chat's response protocol, route cache, lifecycle, or
claims. It reuses only the Pet runtime contract:

- a thread checkpoint may expose one current continuation;
- a Pet-owned continuation identity identifies that wait;
- a Pet runtime may project presentation-safe payload into public JSON;
- a matching resume advances the same checkpoint.

Studio then adds its own explicit target and invocation envelope around that
shared contract.

## Vocabulary and ownership

| Concept | Meaning | Owner | Lifetime |
| --- | --- | --- | --- |
| Studio | Registry and dispatch substrate for resident Pets | Host | Host generation |
| Pet | Stable dispatch target with a resident runtime | Studio registry | Host generation |
| Thread | Durable checkpoint and continuity scope for one Pet | Pet runtime | Across dispatch invocations and restart |
| Dispatch | Producer-neutral call targeting a Pet | Studio API | One accepted call |
| Invocation | Execution created by one dispatch | Studio invocation coordinator | Until complete, failed, cancelled, or pending interrupt |
| Pet continuation | Current resumable checkpoint wait | Pet runtime/checkpointer | Until resumed or replaced |
| public continuation projection | Presentation-safe view of a Pet-owned payload | Pet runtime adapter | Rebuildable |

Studio owns targeting, invocation identity, and per-Pet serialization. The Pet
runtime owns checkpoint interpretation, interrupt validation, and resume.
Projection never owns interrupt existence.

## Dispatch contract

The exact TypeScript shape remains an implementation decision. The required
semantics are:

```ts
type StudioDispatchInput =
  | { kind: 'request'; request: string }
  | { kind: 'resume'; continuationId: string; payload: JsonObject };

type StudioDispatchRequest = {
  petId: string;
  input: StudioDispatchInput;
  metadata?: JsonObject;
  idempotencyKey?: string;
  signal?: AbortSignal;
};

type StudioDispatchReceipt = {
  threadId: string;
  invocationId: string;
  onInvocation: (handler: StudioInvocationEventHandler) => () => void;
  completion: Promise<StudioDispatchResult>;
};

type StudioDispatchResult = {
  petId: string;
  threadId: string;
  invocationId: string;
  status: 'completed' | 'waiting' | 'failed' | 'cancelled';
  pendingContinuation?: PendingContinuationProjection;
};
```

Every accepted call receives a new `invocationId` unless an explicit
`idempotencyKey` resolves to an existing call. Studio resolves the stable
`threadId` from `petId`; callers do not choose the checkpoint namespace.
Dispatch acknowledges acceptance with a receipt immediately. Its scoped
observer replays the latest invocation state, and its `completion` promise
settles when the serialized invocation reaches a terminal or durable interrupt
state, so push-style producers do not need to block on graph work.

Producer metadata is opaque. Studio core does not define a `correlationId`:
producers may put their own task, correlation, or source fields under metadata,
but those fields never replace `petId`, `threadId`, or `invocationId`, and
Studio does not inject them into the Pet runtime.

## Pending continuation projection

The shared projection contains interrupt identity and presentation-safe
payload only:

```ts
type PendingContinuationProjection = {
  continuationId: string;
  payload: JsonObject; // Pet-owned opaque public payload
};
```

It contains no `petId`, `threadId`, or `invocationId`. Studio carries those in
its event/result envelope because they describe delivery context, not the
interrupt itself:

```ts
type StudioInvocationEvent = {
  petId: string;
  threadId: string;
  invocationId: string;
  pendingContinuation?: PendingContinuationProjection;
};
```

The invocation that observed an interrupt and the later invocation that
resumes it have different invocation IDs but the same Pet thread. A stale or
mismatched interrupt resume fails without changing that checkpoint.

## Queue semantics

The per-Pet queue serializes active invocations; it does not keep an invocation
alive after the graph has durably interrupted.

- `busy`: one invocation is executing; later calls wait.
- `waiting`: the prior invocation settled at a durable wait; the next invocation
  may start and the Pet runtime validates whether its input can resume it.
- `open`: the checkpoint has no pending continuation blocking ordinary input.
- `blocked`: execution requires explicit recovery policy; accepted inputs remain
  an implementation decision.

Studio may expose these states as observation, but it does not interpret human
review options or construct graph resume commands.

## Identity consolidation

| Identity | Treatment | Reason |
| --- | --- | --- |
| `studioId` | Keep | Studio namespace and stable Pet-thread scope |
| `petId` | Keep | Explicit Studio dispatch target |
| `threadId` | Keep; one stable value per Studio/Pet | Checkpoint continuity |
| `invocationId` | Keep; one per dispatch | Distinguishes calls sharing a thread |
| `dispatchId` | Do not add | Synonymous with `invocationId` |
| Pet continuation ID | Keep | Canonical pending-continuation identity |
| public `actionId` | Remove after compatibility migration | Duplicates continuation identity |
| interaction IDs | Pet payload only | Studio does not define them |
| Chat `requestId` | Keep inside Chat transport only | Not a Studio identity |
| Studio wire `deliveryId` | Keep inside Studio transport only | Correlates pre-acceptance errors and push delivery; not a runtime identity |
| producer correlation/task fields | Opaque `metadata` | Studio does not own producer workflows |
| `idempotencyKey` | Add only for explicit dispatch deduplication | Distinct from correlation |

## Implementation alignment

- `buildStudioPetThreadId(studioId, petId)` derives one deterministic checkpoint
  namespace for each resident Pet, including after Host restart.
- `createStudio()` creates one invocation per accepted dispatch, serializes only
  active graph invocations, and settles a durable continuation as `waiting`.
- local-agent's `createResidentPetAgentRuntime()` reads the authoritative checkpoint before invocation,
  rejects ordinary input while a continuation is pending, validates its identity
  and Pet-specific payload, and issues a keyed LangGraph resume command.
- Studio owns a typed `studio.dispatch` request/resume wire envelope and emits
  `studio.accepted` plus receipt-scoped `studio.invocation` progress. Plugin events
  remain on the independent in-process bus and are not implicitly attached to a
  request delivery. Producer correlation is opaque `metadata` echoed unchanged
  at the Studio boundary; it is neither transport state, Pet execution context,
  nor part of the Pet thread. Agent Session and the Chat dispatcher contain no
  Studio messages.
- Chat continues to use its own session and review transport. Studio shares no
  review-specific contract with Chat; only the Pet runtime owns that interpretation.

## Implemented migration

1. Added Studio behavior tests for stable Pet threads and distinct invocation IDs.
2. Introduced typed request and opaque continuation-resume dispatch inputs.
4. Resolved the stable thread in the Studio/Pet registry.
5. Let a durable continuation settle the current invocation and admit the next
   serialized dispatch.
6. Made the Pet runtime validate request versus continuation-resume input against
   its checkpoint.
7. Added Studio envelopes around the shared interrupt projection.
8. Removed duplicate action/review IDs and workflow identity from Studio core,
   and removed the old Studio-shaped messages from the Chat protocol.

## Required behavioral tests

- Repeated dispatches to Pet A reuse one thread and receive distinct invocation
  IDs.
- Dispatch to Pet B uses a different thread.
- A request invocation can settle with `waiting` without destroying
  the Pet thread.
- A later interrupt-resume dispatch to Pet A resumes the same thread.
- A stale continuation ID does not mutate checkpoint state.
- Concurrent dispatch calls never execute concurrently on one Pet thread.
- Restart resolves the same Pet thread and pending interrupt.
- Chat projections contain no Studio `petId` or dispatch identity.

## Remaining questions

- How historical random per-dispatch checkpoints are retained.
- Which typed inputs are legal while a Pet is `blocked`.
- Whether idempotency records need durable retention beyond the current Host
  generation.
