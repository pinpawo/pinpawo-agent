# Studio Pet Thread and Dispatch Invocation

> Status: Draft
> Date: 2026-08-22
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
│          ├─ dispatch(request)          -> invocation A2 -> PendingInterrupt
│          └─ dispatch(interrupt resume) -> invocation A3 -> resume -> complete
├─ Pet B ── thread B
└─ Pet C ── thread C
```

The interrupt ends invocation A2, not thread A. A later dispatch may carry the
input that resumes the pending interrupt. Dispatch producers are opaque; their
origin does not change routing or checkpoint semantics.

## Boundary with Chat

PR #682 optimizes the current Chat adapter. Chat has an implicit active session
and thread, uses no Studio dispatch, and needs no `petId` in its interrupt
projection.

Studio does not reuse Chat's response protocol, route cache, lifecycle, or
claims. It reuses only the Pet runtime contract:

- a thread checkpoint may expose one current `PendingInterrupt`;
- `interruptId` identifies that wait;
- a human-review payload can be projected into public interactions;
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
| `PendingInterrupt` | Current resumable checkpoint wait | Pet runtime/checkpointer | Until resumed or replaced |
| human-review projection | Presentation-safe view of an interrupt payload | Adapter/projection | Rebuildable |

Studio owns targeting, invocation identity, and per-Pet serialization. The Pet
runtime owns checkpoint interpretation, interrupt validation, and resume.
Projection never owns interrupt existence.

## Dispatch contract

The exact TypeScript shape remains an implementation decision. The required
semantics are:

```ts
type StudioDispatchInput =
  | { kind: 'request'; request: string }
  | {
      kind: 'resume_interrupt';
      interruptId: string;
      payload: InterruptResumePayload;
    };

type StudioDispatchRequest = {
  petId: string;
  input: StudioDispatchInput;
  metadata?: JsonObject;
  idempotencyKey?: string;
  signal?: AbortSignal;
};

type StudioDispatchResult = {
  threadId: string;
  invocationId: string;
  status: 'completed' | 'pending_interrupt' | 'failed' | 'cancelled';
  pendingInterrupt?: PendingInterruptProjection;
};
```

Every accepted call receives a new `invocationId` unless an explicit
`idempotencyKey` resolves to an existing call. Studio resolves the stable
`threadId` from `petId`; callers do not choose the checkpoint namespace.

Producer metadata is opaque. Studio core does not define a `correlationId`:
producers may put their own task, correlation, or source fields under metadata,
but those fields never replace `petId`, `threadId`, `invocationId`, or
`interruptId`.

## Pending interrupt projection

The shared projection contains interrupt identity and presentation-safe
payload only:

```ts
type PendingInterruptProjection = {
  interruptId: string;
  payload: {
    kind: 'human_review';
    interactions: HumanReviewRequest[];
  };
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
  pendingInterrupt?: PendingInterruptProjection;
};
```

The invocation that observed an interrupt and the later invocation that
resumes it have different invocation IDs but the same Pet thread. A stale or
mismatched interrupt resume fails without changing that checkpoint.

## Queue semantics

The per-Pet queue serializes active invocations; it does not keep an invocation
alive after the graph has durably interrupted.

- `busy`: one invocation is executing; later calls wait.
- `pending_interrupt`: the prior invocation settled at a durable wait; the next
  invocation may start and the Pet runtime validates whether its input can
  resume that wait.
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
| `interruptId` | Keep | Canonical pending-interrupt identity |
| public `actionId` | Remove after compatibility migration | Duplicates `interruptId` |
| `interactionId` | Keep | One interaction inside a review payload |
| deprecated `reviewId` | Compatibility parser only | Alias of `interactionId` |
| Chat `requestId` | Keep inside Chat transport only | Not a Studio identity |
| producer correlation/task fields | Opaque `metadata` | Studio does not own producer workflows |
| `idempotencyKey` | Add only for explicit dispatch deduplication | Distinct from correlation |

## Conflict with current sources

This draft intentionally records a disagreement rather than rewriting current
reference material:

- `packages/studio/src/createStudio.ts` creates a random thread for every
  dispatch and waits for `open` after `waiting`;
- `packages/studio/src/studioContract.ts` treats `threadId` as dispatch identity;
- `services/local-agent/src/studio/studioApiContract.ts` includes workflow
  run/task/conversation identity in the thread namespace;
- issue #561 assumes invocation-specific threads.

Those sources describe current behavior. Issue #684 proposes replacing it with
one stable thread per Pet and one invocation per dispatch. Public Studio
reference docs remain unchanged until implementation and review adopt the new
contract.

## Migration plan

1. Land the shared `PendingInterrupt` vocabulary and checkpoint projection in
   Chat without adding Studio concepts to Chat code.
2. Add Studio behavior tests for stable Pet threads and distinct invocation IDs.
3. Introduce typed request and interrupt-resume dispatch inputs.
4. Resolve the stable thread in the Studio/Pet registry.
5. Let a durable interrupt settle the current invocation and admit the next
   serialized dispatch.
6. Make the Pet runtime validate request versus interrupt-resume input against
   its checkpoint.
7. Add Studio envelopes around the shared interrupt projection.
8. Remove duplicate action/review IDs and workflow identity from Studio core
   after compatibility migration.

## Required behavioral tests

- Repeated dispatches to Pet A reuse one thread and receive distinct invocation
  IDs.
- Dispatch to Pet B uses a different thread.
- A request invocation can settle with `pending_interrupt` without destroying
  the Pet thread.
- A later interrupt-resume dispatch to Pet A resumes the same thread.
- A stale interrupt ID does not mutate checkpoint state.
- Concurrent dispatch calls never execute concurrently on one Pet thread.
- Restart resolves the same Pet thread and pending interrupt.
- Chat projections contain no Studio `petId` or dispatch identity.

## Open questions

- Whether the stable thread ID is derived from `studioId + petId` or persisted
  in the Studio registry.
- How historical random per-dispatch checkpoints are retained.
- Which typed inputs are legal while a Pet is `blocked`.
- The exact shape and retention policy of dispatch idempotency records.
