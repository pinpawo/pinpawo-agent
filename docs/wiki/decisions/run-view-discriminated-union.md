---
title: Active Invocation And Pending Interrupt Are Separate Facts
page_type: decision
status: validated
updated: 2026-08-22
sources:
  - ../../../packages/agent-session/src/domain.ts
  - ../../../packages/agent-session/src/project.ts
  - ../../../services/local-agent/src/tui/tuiLocalServerClient.ts
  - ../../../services/local-agent/src/inflightRequestController.ts
  - ../../../services/local-agent/src/chatSessionAdapter.ts
  - https://github.com/pinpawo/pinpawo-agent/issues/385
  - https://github.com/pinpawo/pinpawo-agent/pull/389
  - https://github.com/pinpawo/pinpawo-agent/pull/468
related:
  - ../local-agent-session-projection.md
  - ../interruption-and-delegation-continuation.md
  - ../concepts/session-projection-ownership.md
  - review-resolution-is-client-local.md
---

# Active Invocation And Pending Interrupt Are Separate Facts

## Decision

The active invocation in an `AgentSession` is a discriminated union
(`AgentRunView`) of exactly two facts, carried in snapshot version 5
([`domain.ts`](../../../packages/agent-session/src/domain.ts)):

- `running` — carries one runtime `activity`: `thinking`, `using_tool`, or
  `streaming`;
- `interrupting` — the server run controller has begun interruption.

The checkpoint-derived `PendingInterrupt` is a separate nullable session field.
It is not an invocation phase.

## Rationale

The earlier flat shape (`phase` enum plus an optional review projection) allowed
illegal combinations and forced consumers to infer a phase/projection
cross-product. Making `pending_interrupt` a third `AgentRunView` variant removed
some illegal shapes but conflated two lifetimes: a checkpoint can remain waiting
while a new response/cancel invocation is already running. That forced
`activeRun.requestId` to become optional and required review-specific rebinding.

The V5 split models both facts directly. An active invocation always has a
required `requestId`; a pending interrupt always has an `interruptId` and
payload, never transport ownership. The two may coexist only while an interrupt
resume is making authoritative progress.

## Constraints

- The initial `running` / `thinking` view is created only **after** the outbound
  run command is accepted by the transport.
- Later `running.activity` changes come from server runtime events. Elapsed-time
  presentation (busy-copy escalation) stays in the render layer and must not leak
  into the shared view.
- `pendingInterrupt` is `null` or carries a complete `PendingInterrupt`.
- Every `running` or `interrupting` view has a required `requestId`.
- Accepting response/cancel creates a new `running` active invocation and keeps
  the pending interrupt until runtime progress, another interrupt, or terminal
  settlement supplies the next authoritative fact.
- A client may project `interrupting` after its transport accepts
  `run.interrupt`; this is command acknowledgement, not terminal settlement.
- `interrupting` is non-terminal. It remains the active run until the invocation
  owner has observed graph output settlement and emits terminal `interrupted`;
  a client timer cannot perform this transition.
- Whether an interrupted review delegation may be offered through `/continue`
  is a separate TUI-local fact, not a fourth `AgentRunView` variant.
- Snapshot versions 1 and 2, `runs[] + activeRunId`, and message-only restore are
  unsupported. V3 `waiting_review/reviewAction` and V4 embedded
  `pending_interrupt` shapes are accepted only by the compatibility parser and
  normalized to V5.

## Consequences

The shared model no longer needs an optional invocation identifier or a
review-specific request-binding transition. Submit-then-Esc targets the new
active invocation by its required `requestId`, while stale review validation
continues to use `interruptId`. This is the type-system counterpart to keeping
review command progress client-local; see
[Review resolution is client-local](review-resolution-is-client-local.md).
The lifecycle beyond `interrupting` is detailed in
[Interruption and delegation continuation](../interruption-and-delegation-continuation.md).
