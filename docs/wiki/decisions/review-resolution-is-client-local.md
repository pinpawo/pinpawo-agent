---
title: Review Resolution Progress Is Client-Local
page_type: decision
status: validated
updated: 2026-08-22
sources:
  - ../../LOCAL_AGENT_SESSION_PROJECTION.md
  - ../../design/local-agent/pending-interrupt-chat.md
  - ../../../services/local-agent/src/pendingHumanReviewInterrupt.ts
  - ../../../packages/agent-session/src/review.ts
  - ../../../services/local-agent/src/localServerChatHandler.ts
  - ../../../services/local-agent/src/tui/TuiRuntimeController.ts
  - ../../../packages/agent-contracts/src/interaction.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/review/reviewSpec.ts
  - https://github.com/pinpawo/pinpawo-agent/issues/385
  - https://github.com/pinpawo/pinpawo-agent/issues/390
  - https://github.com/pinpawo/pinpawo-agent/pull/411
  - https://github.com/pinpawo/pinpawo-agent/pull/425
  - https://github.com/pinpawo/pinpawo-agent/issues/478
  - https://github.com/pinpawo/pinpawo-agent/pull/475
  - https://github.com/pinpawo/pinpawo-agent/pull/485
  - https://github.com/pinpawo/pinpawo-agent/issues/570
  - https://github.com/pinpawo/pinpawo-agent/pull/572
related:
  - ../agent-boundary-contracts.md
  - ../local-agent-session-projection.md
  - ../interruption-and-delegation-continuation.md
  - ../concepts/session-projection-ownership.md
  - ../concepts/studio-pet-thread-dispatch-invocation.md
  - run-view-discriminated-union.md
---

# Review Resolution Progress Is Client-Local

## Scope

This decision is limited to Chat/TUI projection of submission progress. It says
that a client-side "resolution sent" marker is not shared session state. It does
not define how Studio delivers review work to a Pet.

Chat has an implicit active thread and no Studio dispatch or `petId`. The
proposed Studio model may carry an interrupt resume in a later dispatch to the
same Pet thread, but it reuses only the `PendingInterrupt` contract—not Chat's
response protocol or client-local state. See [Studio Pet thread and dispatch
invocation](../concepts/studio-pet-thread-dispatch-invocation.md). Any statement
below about a "client response" is limited to Chat/TUI.

## Decision

Sending a review resolution (response or cancel) is a one-shot client command.
It does **not** change the checkpoint-derived `PendingInterrupt` or add command
progress to it. The shared `pendingInterrupt` remains unchanged until a server
event or snapshot provides the next fact. The only client-side progress is the
TUI-local approval `resolution-sent` phase.

The accepted response/cancel command starts a new `activeRun` with a required
`requestId`, so later events from that resumed invocation can be correlated.
The old `pendingInterrupt` may coexist with that run until authoritative
progress. This is transport ownership, not another interrupt identity or a
`waiting/submitting/canceling` lifecycle.

The shared `PendingInterrupt` projection therefore carries only `interruptId`
and its presentation-safe payload—no `waiting | submitting | canceling` status.
The former `ReviewAction/actionId` names exist only at compatibility parser
boundaries. Canonical code and emitted messages use
`PendingInterrupt/interruptId`.

**Fact (PR #572, revised by PR #682).** The human-review payload's
`interactions[]` are public `HumanReviewRequest` values. They have
presentation/input data and `batchSubmission`, but never runtime decisions or
effects. For every attempt, the server reloads the internal `ReviewSpec[]` from
checkpoint authority, validates the response, and builds the graph resume. See
[Agent boundary contracts](../agent-boundary-contracts.md).

## Rationale

The previous model mixed server-observed run facts with client command progress
through `activeRun.phase` and `ReviewAction.status`. Encoding the legal
combinations as a larger shared state machine would have preserved the underlying
ownership problem. Issue #385 chose to cut the ownership boundary instead:
checkpoint-derived facts are shared; whether the client is currently sending a
resolution is not.

## Client-side gates the marker carries

**Fact.** Between sending a resolution and the first server event, the shared
projection contains both the old `pendingInterrupt` and the newly active
invocation. The local `resolution-sent` phase gates that window on the TUI side:

- a further interrupt request routes to `run.interrupt`, never `review.cancel`
  for the already-resolved action;
- the composer stays gated so no new run can start.

The marker is cleared when server-observed state diverges from that pending
interrupt.

## Server-side ordering

**Decision (issue #390, revised by PR #682).** The Chat handler executes one
shared interrupt-resume flow and reloads the active checkpoint for every
attempt. Thread invocation serialization owns competing Chat calls; the handler
does not maintain an `interruptId`-keyed review existence, claim, or consumed state.
This sequencing is transport control and is never projected (see [transport
boundary](../concepts/local-agent-transport-boundary.md)).

## Cancel from `pending_interrupt`

**Decision (PR #475).** `review.cancel` resolves to the server control action
`interrupt_run`, not to a review reject option. The resumed graph first persists
a canceled `ToolMessage` and a guard stop, then the local server aborts the
invocation after that checkpoint boundary. The subagent performs no subsequent
model call or handoff, and the active delegation lane remains resumable.

**Decision (PR #485).** The TUI records `/continue` availability only if a
review cancel that it sent later ends with the matching server-observed
`interrupted`. This causal marker is separate from the approval
`resolution-sent` phase
and from the shared `PendingInterrupt`: the first controls a later command
affordance, the second prevents duplicate submission, and the third remains the
checkpoint-derived review fact. See the complete
[interruption contract](../interruption-and-delegation-continuation.md).

## Constraints

- Do not add a submission `status` field to `PendingInterrupt` or any differently named
  duplicate of client submission progress in the shared model.
- Do not use `requestId` as the pending wait identity; stale validation always
  uses `interruptId` and then `interactionId`.
- A human-review payload keeps its ordered interactions; `interruptId`
  identifies the checkpoint wait and `interactionId` identifies one item.
- `review.cancel` and `run.interrupt` remain distinct intents.
- `review.cancel` must consume the current review and persist the guard-stop
  boundary before aborting; a queued cancel must not target a newer review.
- Reconnect may discard client-local draft/submission state; the snapshot and
  runtime facts rematerialize shared state. Snapshot must not become a
  command-recovery mechanism.

## Consequences

Duplicate submissions are serialized and revalidated against the latest active
checkpoint. A re-ask refreshes the current payload, and a stale response cannot
mutate a newer pending interrupt.
