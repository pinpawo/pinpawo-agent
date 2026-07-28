---
title: Review Resolution Progress Is Client-Local
page_type: decision
status: validated
updated: 2026-07-28
sources:
  - ../../LOCAL_AGENT_SESSION_PROJECTION.md
  - ../../../services/local-agent/src/reviewResolutionLifecycle.ts
  - ../../../services/local-agent/src/humanReviewActionRouting.ts
  - ../../../packages/agent-session/src/review.ts
  - ../../../services/local-agent/src/localServerChatHandler.ts
  - ../../../services/local-agent/src/tui/TuiRuntimeController.ts
  - https://github.com/pinpawo/pinpawo-agent/issues/385
  - https://github.com/pinpawo/pinpawo-agent/issues/390
  - https://github.com/pinpawo/pinpawo-agent/pull/411
  - https://github.com/pinpawo/pinpawo-agent/pull/425
  - https://github.com/pinpawo/pinpawo-agent/issues/478
  - https://github.com/pinpawo/pinpawo-agent/pull/475
  - https://github.com/pinpawo/pinpawo-agent/pull/485
related:
  - ../local-agent-session-projection.md
  - ../interruption-and-delegation-continuation.md
  - ../concepts/session-projection-ownership.md
  - run-view-discriminated-union.md
---

# Review Resolution Progress Is Client-Local

## Decision

Sending a review resolution (response or cancel) is a one-shot client command. It
does **not** mutate the shared `AgentSession`. The shared projection stays at
`waiting_review` until a server event or snapshot provides the next fact. The only
client-side progress is the TUI-local `ReviewDraft.resolutionSent` marker.

`ReviewAction` therefore carries only checkpoint-derived batch identity
(`actionId`) and ordered `reviews[]` — no `waiting | submitting | canceling`
status (removed in PR #388).

## Rationale

The previous model mixed server-observed run facts with client command progress
through `activeRun.phase` and `ReviewAction.status`. Encoding the legal
combinations as a larger shared state machine would have preserved the underlying
ownership problem. Issue #385 chose to cut the ownership boundary instead:
checkpoint-derived facts are shared; whether the client is currently sending a
resolution is not.

## Client-side gates the marker carries

**Fact.** Between sending a resolution and the first server event, the shared
projection still says `waiting_review`. The `resolutionSent` marker gates that
window on the TUI side:

- a further interrupt request routes to `run.interrupt`, never `review.cancel`
  for the already-resolved action;
- the composer stays gated so no new run can start.

The marker is cleared when server-observed state diverges from the waiting review
action.

## Server-side lifecycle and ordering

**Decision (issue #390).** Server-side route, claim, consumption, and
interrupt-ordering state are converged into one `actionId`-keyed
[`ReviewResolutionLifecycle`](../../../services/local-agent/src/reviewResolutionLifecycle.ts)
(PR #411), and both chat handlers execute one shared
`resolveHumanReviewAction` flow (PR #425) with only their real boundary
differences injected. Route recovery re-reads checkpoint state; a failed or
interrupted resume releases its claim so the next attempt re-reads authority.
This lifecycle is transport control state and is never projected (see
[transport boundary](../concepts/local-agent-transport-boundary.md)).

## Cancel from `waiting_review`

**Decision (PR #475).** `review.cancel` resolves to the server control action
`interrupt_run`, not to a review reject option. The resumed graph first persists
a canceled `ToolMessage` and a guard stop, then the local server aborts the
invocation after that checkpoint boundary. The subagent performs no subsequent
model call or handoff, and the active delegation lane remains resumable.

**Decision (PR #485).** The TUI records `/continue` availability only if a
review cancel that it sent later ends with the matching server-observed
`interrupted`. This causal marker is separate from `ReviewDraft.resolutionSent`
and from the shared `ReviewAction`: the first controls a later command
affordance, the second prevents duplicate submission, and the third remains the
checkpoint-derived review fact. See the complete
[interruption contract](../interruption-and-delegation-continuation.md).

## Constraints

- Do not reintroduce a `status` field on `ReviewAction` or any differently named
  duplicate of client submission progress in the shared model.
- Batch review stays first-class: one `actionId` identifies an ordered
  `reviews[]` batch, order preserved end to end.
- `review.cancel` and `run.interrupt` remain distinct intents.
- `review.cancel` must consume the current review and persist the guard-stop
  boundary before aborting; a queued cancel must not target a newer review.
- Reconnect may discard client-local draft/submission state; the snapshot and
  runtime facts rematerialize shared state. Snapshot must not become a
  command-recovery mechanism.

## Consequences

Duplicate submissions are rejected across request envelopes; a newly observed
pending event can reopen the same action; and the interrupt intent cannot race a
newer review action owned by the same run.
