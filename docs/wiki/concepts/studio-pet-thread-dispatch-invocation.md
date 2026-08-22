---
title: Studio Pet Thread and Dispatch Invocation
page_type: concept
status: contested
updated: 2026-08-22
sources:
  - ../../design/studio/pet-thread-dispatch-invocation.md
  - ../../design/local-agent/pending-interrupt-chat.md
  - ../../../packages/studio/src/studioContract.ts
  - ../../../packages/studio/src/createStudio.ts
  - ../../../services/local-agent/src/studio/createPetAgentRuntime.ts
  - ../../../services/local-agent/src/studio/studioApiContract.ts
  - https://github.com/pinpawo/pinpawo-agent/issues/684
  - https://github.com/pinpawo/pinpawo-agent/issues/561
  - https://github.com/pinpawo/pinpawo-agent/pull/682
related:
  - ../agent-boundary-contracts.md
  - session-projection-ownership.md
  - ../decisions/review-resolution-is-client-local.md
  - ../local-agent-session-projection.md
---

# Studio Pet Thread and Dispatch Invocation

This page records the proposed Studio model tracked by issue
[#684](https://github.com/pinpawo/pinpawo-agent/issues/684). It remains
`contested` because current implementation and issue #561 use invocation-specific
threads. Current public behavior remains under `docs/reference/`.

## Boundary with Chat

PR #682 is a Chat adapter optimization. Chat has an implicit active session and
thread; it has no Studio dispatch and its interrupt projection contains no
`petId`.

Studio reuses only the checkpoint contract established by the Chat work:

```text
Thread checkpoint -> PendingInterrupt -> presentation-safe projection
matching interruptId + resume payload -> resume same checkpoint
```

It does not reuse Chat's response protocol, request IDs, route cache, or review
lifecycle. Studio adds `petId`, stable Pet-thread resolution, `invocationId`, and
producer-neutral dispatch in its own envelopes.

## Proposed Studio model

One resident Pet owns one durable thread in a Studio. Every dispatch call is a
new invocation on that thread, and invocations for one Pet are serialized.

```text
Pet A / thread A
  dispatch(request)          -> invocation A1 -> complete
  dispatch(request)          -> invocation A2 -> PendingInterrupt
  dispatch(interrupt resume) -> invocation A3 -> resume thread A
```

The interrupt settles invocation A2, not thread A. The later resume is the input
of invocation A3. Dispatch provenance is opaque and does not affect routing or
checkpoint authority.

## Identity map

| Identity | Canonical role | Scope |
| --- | --- | --- |
| `studioId` | Studio namespace | Studio/host generation |
| `petId` | Stable dispatch target | Studio |
| `threadId` | Stable Pet checkpoint namespace | Across the Pet's invocations |
| `invocationId` | One accepted dispatch | One invocation |
| `interruptId` | Current checkpoint wait | One pending interrupt |
| `interactionId` | One item in a human-review payload | One interrupt payload |
| `idempotencyKey` | Optional dispatch deduplication | Producer/Studio agreement |

`dispatchId` is not added because it duplicates `invocationId`. Public
`actionId` should migrate to `interruptId`; deprecated `reviewId` remains a wire
alias for `interactionId` only.

Chat `requestId` is not a Studio identity. Producer task, correlation, source,
or conversation fields may travel as opaque metadata but are not part of Pet
thread or invocation identity. Studio core defines no generic `correlationId`.

## Projection boundary

The shared interrupt projection is delivery-neutral:

```ts
type PendingInterruptProjection = {
  interruptId: string;
  payload: {
    kind: 'human_review';
    interactions: HumanReviewRequest[];
  };
};
```

It contains no `petId`, `threadId`, or `invocationId`. Studio wraps it when those
delivery coordinates are required:

```ts
type StudioInvocationEvent = {
  petId: string;
  threadId: string;
  invocationId: string;
  pendingInterrupt?: PendingInterruptProjection;
};
```

`ReviewSpec -> HumanReviewRequest` remains presentation-only and does not expose
runtime decisions, effects, tool arguments, or graph resume commands.

## Queue behavior

A per-Pet queue serializes active invocations. A durable interrupt settles the
current invocation, so the next dispatch may reach the Pet runtime. That runtime
validates whether the new typed input can resume the pending checkpoint.

The current queue instead waits for the Pet gate to become `open` after
`waiting`; that prevents the dispatch which would carry the resume. Issue #684
must change this without putting Studio queue semantics into Chat code.

## Current contradiction

Current `createStudio()` generates a random thread for each dispatch and uses it
as dispatch identity. Issue #561 and `studioApiContract.ts` also include
workflow-specific run/task/conversation identities in thread namespaces.

The proposed model replaces those assumptions with one stable thread per Pet
and one invocation per dispatch. See the full
[design draft](../../design/studio/pet-thread-dispatch-invocation.md) for the
migration sequence and required tests.
