# Interrupt Domain

> Status: Draft
> Date: 2026-09-07
> Related: issues #675, #747, #754, #756, #772; PRs #682, #758, #766, #767, #770
> Kind semantics: [Review and Interrupt Runtime Design](review.md)
> Host boundary: [Resident Pet Host ports](resident-pet-host-ports.md)

## Purpose

Interrupt is the one interaction primitive of the Agent runtime. Every case
where execution stops and waits for a person is an interrupt, and every
continuation is a resume of that interrupt by id.

Two kinds exist today:

- `human_review`: a proposed action waits for a decision.
- `pause_task`: execution stopped with the task unfinished, and can continue.

[review.md](review.md) defines the semantics of each kind. This document
defines what is **common** to all kinds and, more importantly, what every
layer between the Runtime and the person is **not allowed to know**.

The current implementation grew the two kinds as two separate chains. Review
has its own events, messages, projection, handler entry points, and settlement
status. Pause has a state channel, a legacy request field, and a projection
without an id. Recent work (#766, #767, #770) made pause a real interrupt and
straightened the abort path. This document is the target those changes were
clearing ground for.

## Decisions

1. **One chain, not one per kind.** The Runtime raises interrupts; the Host
   reads and settles them; the protocol carries them; interfaces render and
   resume them. Each layer has exactly one contract for every kind.
2. **Identity is the LangGraph interrupt id.** An interrupt exists if and only
   if it appears in `tasks[].interrupts[]`. There is no second source of truth:
   no state channel, no "has pending continuation" derivation, no
   resumability heuristic.
3. **Kind is opaque between the Runtime and the interface.** Only two places
   read `payload.kind`: the Runtime when it parses a resume value, and the
   interface when it picks what to render and what value to send back. The
   Host, the protocol parser, the Agent Session projection, and the handler
   entry points are kind-blind.
4. **Resume is a value by id.** A kind defines the shape of its resume value.
   Cancelling a review and continuing a pause are both resume values, not
   separate request types.
5. **Origin is private to the kind.** A kind may be raised for more than one
   reason. `pause_task` is raised when a review resolution ends the task
   unfinished, and when an invocation is aborted with work remaining. Nothing
   above the Runtime learns which; both are the same interrupt, continued the
   same way.
6. **No compatibility layer.** Each change replaces a piece of the review or
   pause chain with the interrupt chain and deletes what it replaces in the
   same change. There are no legacy aliases, dual emissions, or deprecated
   fields kept for a phase.

## The chain

```text
Runtime    interrupt(payload)                payload.kind ∈ {human_review, pause_task}
             ↓ getState().tasks[].interrupts[] → { id, value }
Host       readPendingInterrupt(snapshot) → { interruptId, payload }       kind-blind
           settle: 'waiting' | 'completed' | 'interrupted' | 'failed'
             ↓ runtime event  interrupt.requested { requestId, interruptId, payload }
Session    pendingInterrupt { interruptId, payload }                        kind-blind
Interface  render by payload.kind; on user action build a resume value
             ↓ client message interrupt.resume { requestId, interruptId, value }
Host       Command({ resume: { [interruptId]: value } })                    kind-blind
Runtime    AgentInterrupt.resume(value)                                     parses by kind
```

### Runtime

- Each kind is an `AgentInterrupt` with `interaction()` (the payload),
  `resume(value)` (parse or throw), and the choice of **where** in the graph
  the interrupt is raised. Review raises inside the subagent's afterModel
  boundary. Pause raises at the root `pauseGate` node, after the capability
  node has committed the pending delegation, for every origin. Both surface
  in the root snapshot's `interrupts[]`.
- A kind declares its **new-input policy**: what happens if a fresh
  `chat_request` arrives while it is pending. `human_review` refuses (the
  reviewed tool call must be answered; the Host re-raises the same interrupt).
  `pause_task` supersedes (LangGraph drops the pending gate and the Runtime's
  default transition detaches the unfinished delegation). The Host asks the
  Runtime for this policy; it does not branch on the kind literal.
- Successive `interrupt()` calls in one task share an id. A kind therefore owns
  one task; a resolution that leads to another kind unwinds to that kind's own
  node rather than interrupting again in place. This is why a review
  rejection ends the subagent and lets `pauseGate` raise the pause.
- `pause_task` from an aborted invocation is the open design point of #754.
  The constraint this domain imposes is only that the result is a
  `pause_task` interrupt with an id in `interrupts[]`, so the rest of the
  chain is unchanged. A candidate mechanism is to settle the abort by invoking
  the root graph toward `pauseGate`, so the gate raises against the last
  committed delegation state. Until that lands, an aborted run with retained
  work is not continuable, and interfaces must not pretend it is.

### Host

- `readPendingInterrupt(snapshot)` returns `{ interruptId, payload }` for any
  recognized kind and throws for an unknown payload. It never returns `null`
  for an interrupt it does not understand.
- Settlement after a turn is one of four states. `waiting` covers every
  pending interrupt. `interrupted` is reserved for an aborted run.
- The resident Host's dispatch admission reads the same function: a pending
  interrupt of any kind holds dispatch as `waiting`.
- The Host resumes by building `Command({ resume: { [interruptId]: value } })`
  from the client message unchanged. It validates identity (session, id) and
  nothing about the value.
- `run.interrupt` aborts a running run and nothing else. The Host does not
  resolve, cancel, or translate a pending interrupt on a request's behalf.
- Finalization of an interrupted run is one path, described in #770: close
  operations, publish `run.interrupted`, clear the inflight run.

### Protocol

Runtime events:

- `interrupt.requested { requestId, interruptId, payload }`. The payload is
  the kind's interaction payload.
- Error codes `interrupt_closed`, `interrupt_stale`, `interrupt_wrong_session`.

Client messages:

- `interrupt.resume { requestId, interruptId, value }`.
- `chat_request` carries a message and nothing about execution semantics.
  Whether it continues or supersedes is decided by the pending interrupt's
  new-input policy in the Runtime (#756).
- `run.interrupt { requestId }` aborts the running run.

Snapshot projection:

- `pendingInterrupt { interruptId, payload }` for every kind. The
  `interruptId` is required.

### Interface

- Renders by `payload.kind`. Builds the resume value by kind: review decisions
  and review cancel per [review.md](review.md); pause continue as
  `{ action: 'continue', guidance? }`.
- The Esc key is an interface gesture, not a domain concept. Its meaning
  depends on what the interface is showing: while a run is running it sends
  `run.interrupt`; while a `human_review` is pending it sends
  `interrupt.resume` with the cancel value; while a `pause_task` is pending it
  leaves paused mode locally, as
  [delegation-pause-interaction.md](../tui/delegation-pause-interaction.md)
  specifies, and the next message supersedes through the Runtime.
- The composer is unavailable while a `human_review` interrupt is pending and
  available while a `pause_task` interrupt is pending. That is a UX choice;
  the enforcement point is the Runtime's new-input policy.

## Current deviations

| Layer | Target | Today | Where |
|---|---|---|---|
| Host read | any kind by id | only `human_review`; other kinds return `null` | `services/local-agent/src/agentGraphService.ts` `projectPendingInterrupt` |
| Host read | no second source | `pauseTaskInterrupt` channel + `hasPendingContinuation` | `agentGraphService.ts`, `residentPetHost.ts` `readSettledState` |
| Host settle | `waiting` | `waiting_human` for review; `paused` reported as `interrupted` | `chatSessionAdapter.ts`, `localServerChatHandler.ts` |
| Host resume | one entry | `handleHumanReviewResponse`, `handleReviewCancel`, `handleRunInterrupt` review branch, `handleChatRequest` transition | `localServerChatHandler.ts` |
| Event | `interrupt.requested` | `human_review.requested`; pause has no event | `packages/agent-session/src/events.ts` |
| Projection | `{ interruptId, payload }` | review has id, pause does not; `readHumanReviewPendingInterrupt` narrowing | `packages/agent-session/src/review.ts` |
| Client resume | `interrupt.resume` | `human_review_response`, `review.cancel`, `chat_request.activeDelegationTransition` | `packages/agent-session/src/protocol.ts`, `services/tui/src/session/sessionController.ts` |
| Runtime | pause is an interrupt | done in #766 (`pauseGate`); `taskPauseInterrupt` channel still written for Host readers | `packages/pet-agent/src/agent/orchestrator/runtime/nodes/pauseGate.ts` |
| Runtime | new-input policy on the kind | Host refuses text over a pending review inline; pause supersede is the `buildRunStateReset` default | `chatSessionAdapter.ts`, `packages/pet-agent/src/agent/orchestrator/state.ts` |

## Migration

Three replacements. Each one deletes what it replaces. Prerequisites: #766,
#767, #770 merged.

### Replacement 1: pause continues by id

Pause had no wire contract of its own, so this replacement touches nothing
that review uses and can land first.

- Add `interrupt.resume` to the protocol and the Host, resuming any id with
  an opaque value.
- `readPendingInterrupt` returns `pause_task` interrupts with their id; the
  `pendingInterrupt` projection carries `interruptId` for pause.
- Settlement of a pending pause is `waiting`.
- The TUI's continue action sends `interrupt.resume` with the pause continue
  value.
- Delete in the same change: `chat_request.activeDelegationTransition`,
  `LegacyActiveDelegationTransition`, `resume_active`, the externally
  settable `runActiveDelegationTransition` (supersede stays as the Runtime
  default), the `taskPauseInterrupt` state channel, `hasPendingContinuation`,
  the adapter's `paused` result and the handler's `paused` branch, and the
  `pauseTaskInterrupt` line in `readSettledState`.

### Replacement 2: review moves onto the same chain

- `interrupt.requested` replaces `human_review.requested`.
- `interrupt.resume` carries review decisions and review cancel.
- `waiting` replaces `waiting_human`.
- `readPendingInterrupt` recognizes every kind and throws on an unknown
  payload; `pendingInterrupt` is one shape.
- The new-input policy moves to the Runtime; the Host's inline refusal of
  text over a pending review is replaced by consulting it.
- The Host has one resume entry point. `handleRunInterrupt` keeps its
  inflight and resident-run branches only.
- Error codes become `interrupt_*`.
- TUI, Studio Console, and the macOS companion switch in the same change.
- Delete in the same change: `human_review.requested`,
  `human_review_response`, `review.cancel`, `handleHumanReviewResponse`,
  `handleReviewCancel`, the review branch of `handleRunInterrupt`,
  `readHumanReviewPendingInterrupt`, the `review_*` error codes.

### Replacement 3: abort raises a pause

- #754. An aborted invocation with unfinished work ends as a `pause_task`
  interrupt with an id. Nothing above the Runtime changes, which is the test
  that Replacements 1 and 2 were done right.

## Required behavioral coverage

- A `human_review` and a `pause_task` interrupt project through the same Host
  function with an id, and resume through the same client message.
- An unknown interrupt payload fails loudly at the Host, never silently
  reports "no interrupt".
- A pause is visible to a reconnecting client with its id, from the snapshot
  alone.
- A `chat_request` over a pending review is refused by the Runtime's policy;
  over a pending pause it supersedes and the unfinished delegation is
  detached without fabricating a handoff.
- A review-origin pause and an abort-origin pause are indistinguishable above
  the Runtime and continue through the same resume value.
- No handler, adapter, or projection code outside the Runtime and the
  interface renderers compares `payload.kind` to a literal.

## Non-goals

- Changing review decision semantics, batch behavior, or authorization
  scopes. Those stay in [review.md](review.md).
- A third interrupt kind. The chain must not need to change for one, which is
  the test of this design, but none is planned.
- Studio-specific interrupt surfaces beyond consuming the same protocol.
