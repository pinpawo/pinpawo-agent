---
title: Session Projection Ownership Boundaries
page_type: concept
status: validated
updated: 2026-07-23
sources:
  - ../../LOCAL_AGENT_SESSION_PROJECTION.md
  - ../../../services/local-agent/src/localAgentSession.ts
  - ../../../services/local-agent/src/tui/state/tuiState.ts
  - ../../../services/local-agent/src/reviewResolutionLifecycle.ts
  - https://github.com/pinpawo/pinpawo-agent/issues/385
  - https://github.com/pinpawo/pinpawo-agent/issues/390
related:
  - ../local-agent-session-projection.md
  - checkpoint-snapshot-timeline.md
  - ../decisions/review-resolution-is-client-local.md
---

# Session Projection Ownership Boundaries

The central invariant of the projection is that each fact has exactly one owner.
The refactor's own concept audit found that the client and contract layers
converged cleanly, while server transport-control state briefly accreted; issue
#390 addressed that. This page records where each responsibility lives.

## Four owners of review state

**Decision (issue #385).** A pending review is represented by four things with
different owners and lifecycles — do not collapse them:

| Fact | Owner | Lifetime |
| --- | --- | --- |
| `ReviewAction` (`actionId` + ordered `reviews[]`) | shared / checkpoint-derived | while the checkpoint interrupt exists |
| Partial decisions + `resolutionSent` marker (`ReviewDraft`) | TUI-local interaction state | until server-observed state diverges |
| Route + claim + consumption + interrupt ordering | server-local `ReviewResolutionLifecycle` | per resolution attempt |
| Run activity / waiting / interrupting | shared, server-observed | reduced from server events |

`ReviewAction` contains only checkpoint-derived batch identity and ordered review
specs — never client command progress. Sending a review resolution does **not**
optimistically advance the shared projection; the next server event or snapshot
provides the next shared fact.

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

## What the shared reducer must never depend on

**Fact.** `reduceSession` reads no clock, socket, file, singleton, or UI state;
observation time is injected as `observedAt`. This purity is what lets the TUI and
the hosted adapter run the same transition logic. See
[the projection system page](../local-agent-session-projection.md).

## Server transport-control state is never projected

**Decision (issue #390).** `ReviewResolutionLifecycle` and the run command
sequencing it absorbed are server-local transport control state. They are never
projected into `LocalAgentSession` or a snapshot. Client-command progress and
one-shot run-interrupt handling stay out of the shared model; a user-triggered
`run.interrupt` adds no client-side pending domain state.
