---
title: Session Projection Ownership Boundaries
page_type: concept
status: validated
updated: 2026-08-22
sources:
  - ../../LOCAL_AGENT_SESSION_PROJECTION.md
  - ../../../packages/agent-session/src/domain.ts
  - ../../../packages/agent-session/src/project.ts
  - ../../../packages/agent-session/src/snapshot.ts
  - ../../../packages/agent-contracts/src/interaction.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/review/reviewSpec.ts
  - ../../../services/local-agent/src/tui/state/tuiState.ts
  - ../../../services/local-agent/src/tui/TuiRuntimeController.ts
  - ../../design/local-agent/pending-interrupt-chat.md
  - https://github.com/pinpawo/pinpawo-agent/issues/385
  - https://github.com/pinpawo/pinpawo-agent/issues/390
  - https://github.com/pinpawo/pinpawo-agent/pull/468
  - https://github.com/pinpawo/pinpawo-agent/pull/475
  - https://github.com/pinpawo/pinpawo-agent/pull/485
  - https://github.com/pinpawo/pinpawo-agent/issues/570
  - https://github.com/pinpawo/pinpawo-agent/pull/572
related:
  - ../agent-boundary-contracts.md
  - ../local-agent-session-projection.md
  - ../interruption-and-delegation-continuation.md
  - checkpoint-snapshot-timeline.md
  - ../decisions/review-resolution-is-client-local.md
  - studio-pet-thread-dispatch-invocation.md
---

# Session Projection Ownership Boundaries

> Scope note: this page describes the Chat/TUI session projection. Chat has an
> implicit active thread and uses neither `petId` nor Studio dispatch. The
> proposed Studio model wraps the shared interrupt projection in its own target
> and invocation envelope. See [Studio Pet thread and dispatch
> invocation](studio-pet-thread-dispatch-invocation.md).

The central invariant of the projection is that each fact has exactly one owner.
The refactor's own concept audit found that the client and contract layers
converged cleanly, while server transport-control state briefly accreted; issue
#390 addressed that. This page records where each responsibility lives.

## Owners of interrupt and interaction state

**Decision (issue #385, revised by PR #682).** A pending interrupt and the local
interaction around it have distinct owners—do not collapse them:

| Fact | Owner | Lifetime |
| --- | --- | --- |
| `PendingInterrupt` (`interruptId` + presentation-safe payload) | shared / checkpoint-derived projection | while the checkpoint interrupt exists |
| Partial decisions + `resolutionSent` marker (`ReviewDraft`) | TUI-local interaction state | until server-observed state diverges |
| Internal `ReviewSpec[]`, decisions, effects, and resume payload | Pet runtime checkpoint | while the interrupt exists |
| Run activity / waiting / interrupting | shared, server-observed | reduced from server events |

Human review is one `PendingInterrupt` payload. Its projection contains only
interrupt identity and ordered public interactions—never client command
progress. Sending an interrupt resume does **not** optimistically advance the
shared projection; the next server event or snapshot provides the next fact.

**Fact (PR #572, revised by PR #682).** The shared interactions are
presentation-only boundary contracts. For each response attempt, the server
reloads the authoritative internal `ReviewSpec[]` from the active checkpoint,
validates the response, and builds the resume. It retains no independent review
existence or lifecycle state; see
[Agent boundary contracts](../agent-boundary-contracts.md).

## What is TUI-local, not shared

**Fact.** Composer history, focus, connection copy, partial review drafts, the
one-shot review-resolution send marker, `ui.composerTarget`, viewport state, and
the snapshot application reason are TUI-owned and are not part of the shared
projection or snapshot.

- `ui.composerTarget` (`chat | studio`) is a UI routing choice and is **not** the
  same concept as `session.kind`, which classifies the focused session
  projection. Consumers must not derive one from the other.
- `statusNotice` holds presentation copy that cannot be derived (recovered error,
  completed-interrupt notice). Transport `connection` state holds only status and
  optional detail. Run/review activity is derived from the focused session, not
  copied into connection state.
- The TUI retains `sessions + focusedSessionId` deliberately: session-keyed state
  keeps late/background runtime events scoped to their owning session instead of
  mutating the focused one. It is single-focus / single-connection today;
  retaining the map does not imply multiple panes or a second durable store.
- The pending correlation between a TUI-sent `review.cancel` and its request's
  terminal result, plus the session-local `/continue` availability marker, are
  also TUI-owned. The marker is set only after the matching server-observed
  `interrupted`, is consumed by the next accepted request, and is not serialized
  in `AgentSessionSnapshot`.

**Decision (PR #485).** The continuation marker is deliberately narrower than
checkpoint resumability. It records what this TUI can safely explain to the user,
not every active delegation the graph might be able to resume. See
[Interruption and delegation continuation](../interruption-and-delegation-continuation.md).

## What the shared reducer must never depend on

**Fact.** `reduceSession` reads no clock, socket, file, singleton, or UI state;
observation time is injected as `observedAt`. This purity is what lets the TUI and
the hosted adapter run the same transition logic. See
[the projection system page](../local-agent-session-projection.md).

## Server transport-control state is never projected

**Decision (issue #390, refined by PR #682).** Chat invocation serialization and
one-shot run-interrupt handling are server-local transport control. They are
never projected into `AgentSession` or a snapshot. The handler reloads the
active thread checkpoint for projection and resume rather than maintaining a
second review lifecycle. Client command progress remains local.

**Fact.** Inflight request ownership is another server-local control fact. An
interrupt signal changes the projected run to `interrupting`, but the invocation
owner retains control until graph output settles, emits terminal `interrupted`,
and clears the request. Neither the TUI nor a timeout may terminalize it.
