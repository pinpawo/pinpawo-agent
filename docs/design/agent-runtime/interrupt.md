# Interrupt Domain

> Status: Draft
> Date: 2026-09-07
> Related: issues #675, #747, #754, #756, #772; PRs #682, #758, #766, #767, #770
> Kind semantics: [Review and Interrupt Runtime Design](review.md)
> Host boundary: [Resident Pet Host ports](resident-pet-host-ports.md)

## Purpose

Interrupt is the one interaction primitive of the Agent runtime. Every case
where execution stops and waits for a person is an interrupt, and every
continuation of a pending interrupt is a resume of that interrupt by id. An
ordinary next message is not a continuation; it is new input.

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
   entry points are kind-blind. The Runtime exports the decoder that turns a
   raw LangGraph interrupt into `{ interruptId, payload }` or throws on a
   payload it does not recognize; the Host calls that decoder and holds no
   kind knowledge of its own.
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
  boundary. A review-origin pause raises at the root `pauseGate` node after
  the capability node has committed the pending delegation; that is the
  current implementation, not a rule for every origin. Both surface in the
  root snapshot's `interrupts[]`.
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
- `pause_task` from an aborted invocation applies only when the abort left
  unfinished task work. An abort with nothing to continue, such as during a
  root answer stream with no delegation, is an `interrupted` run and not a
  pause. Where the Runtime raises an abort-origin pause and how it re-enters
  are Runtime-private. The constraint this domain imposes is only that the
  result is a `pause_task` interrupt with an id in `interrupts[]`, so the rest
  of the chain is unchanged.
- Cancellation settlement returns the domain's own type:
  `settleAbortedRun(graph): Promise<PendingInterrupt | null>`. A returned
  interrupt — pre-existing or newly raised — is reported as `waiting` and
  published on the `interrupt.requested` chain, with no distinction between a
  review-origin and an abort-origin pause; `null` means the cancelled run
  reports `interrupted`. A settlement that throws takes the caller's failure
  path: it is never caught and reported as `null` or as a clean interruption.
- The internal progression settlement uses to reach the pause boundary is
  `continueFromCheckpoint()`, not a resume. It carries no value and never
  reaches `AgentInterrupt.resume`, which stays responsible only for each
  kind's interaction and reply parsing.

### Host

- `readPendingInterrupt(snapshot)` applies the Runtime's decoder to the
  snapshot's `interrupts[]` and returns `{ interruptId, payload }`, or throws
  when the decoder does. It never returns `null` for an interrupt it does not
  understand.
- Settlement after a turn is one of four states. `waiting` covers every
  pending interrupt. `interrupted` is reserved for an aborted run.
- The resident Host's dispatch admission reads the same function: a pending
  interrupt of any kind holds dispatch as `waiting`.
- The Host resumes by building `Command({ resume: { [interruptId]: value } })`
  from the client message unchanged. It validates identity (session, id) and
  nothing about the value.
- `run.interrupt` aborts a running run and nothing else. When no run is
  running for the request, because the run already settled into an
  interrupt before the interface observed it, the Host re-emits
  `interrupt.requested` for the pending interrupt and does nothing further.
  It does not resolve, cancel, or translate a pending interrupt on a
  request's behalf; the person sees the current interrupt and acts on it.
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
- The interface can be behind the Host: it shows running while the Host has
  already raised an interrupt. A `run.interrupt` sent in that window is
  answered by the re-emitted `interrupt.requested`; the interface reconciles
  to the pending interrupt and discards the stale gesture. It does not retry
  the abort and does not infer a cancel from it.
- The composer is unavailable while a `human_review` interrupt is pending and
  available while a `pause_task` interrupt is pending. That is a UX choice;
  the enforcement point is the Runtime's new-input policy.

## Current deviations

| Layer | Target | Today | Where |
|---|---|---|---|
| Host read | any kind by id | only `human_review`; other kinds return `null` | `services/local-agent/src/agentGraphService.ts` `projectPendingInterrupt` |
| Host read | no second source | `pauseTaskInterrupt` channel + `hasPendingContinuation` | `agentGraphService.ts`, `residentPetHost.ts` `readSettledState` |
| Host settle | `waiting` | done: settlement returns `PendingInterrupt \| null`, reported as `waiting` / `interrupted` | `agentGraphService.ts`, `serverChatHandler.ts`, `residentPetHost.ts` |
| Host resume | one entry | `handleHumanReviewResponse`, `handleReviewCancel`, `handleRunInterrupt` review branch, `handleChatRequest` transition | `localServerChatHandler.ts` |
| Event | `interrupt.requested` | `human_review.requested`; pause has no event | `packages/agent-session/src/events.ts` |
| Projection | `{ interruptId, payload }` | review has id, pause does not; `readHumanReviewPendingInterrupt` narrowing | `packages/agent-session/src/review.ts` |
| Client resume | `interrupt.resume` | `human_review_response`, `review.cancel`, `chat_request.activeDelegationTransition` | `packages/agent-session/src/protocol.ts`, `services/tui/src/session/sessionController.ts` |
| Runtime | pause is an interrupt | done in #766 (`pauseGate`); `taskPauseInterrupt` channel still written for Host readers | `packages/pet-agent/src/agent/orchestrator/runtime/nodes/pauseGate.ts` |
| Runtime | new-input policy on the kind | Host refuses text over a pending review inline; pause supersede is the `buildRunStateReset` default | `chatSessionAdapter.ts`, `packages/pet-agent/src/agent/orchestrator/state.ts` |

## Migration

Three replacements. Each one deletes what it replaces. Prerequisites: #766,
#767, #770 merged.

### Replacement 1: one notification, pause continues by id

The notification comes first because a pause that settles as `waiting`
without an event leaves the interface with an open run and no id. The event
is the same for every kind, so it replaces `human_review.requested` here
rather than adding a pause-only notice.

- The Runtime exports the interrupt decoder; `readPendingInterrupt` uses it
  and returns `{ interruptId, payload }` for both kinds, throwing on an
  unknown payload.
- `interrupt.requested { requestId, interruptId, payload }` replaces
  `human_review.requested` for every kind. The TUI reduces it by
  `payload.kind`: `human_review` into the existing review projection,
  `pause_task` by finishing the owned run and setting `pendingInterrupt`
  with the id. A pause is no longer inferred from a snapshot that follows an
  interrupted run.
- Settlement of any pending interrupt is `waiting`.
- `interrupt.resume` is added to the protocol and the Host, resuming any id
  with an opaque value. The TUI's continue action sends it with the pause
  continue value.
- `pendingInterrupt` carries `interruptId` for every kind.
- Delete in the same change: `human_review.requested`,
  `chat_request.activeDelegationTransition`,
  `LegacyActiveDelegationTransition`, `resume_active`, the externally
  settable `runActiveDelegationTransition` (supersede stays as the Runtime
  default), the `taskPauseInterrupt` state channel, `hasPendingContinuation`,
  the adapter's `waiting_human` and `paused` results and the handler's
  branches for them, the `pauseTaskInterrupt` line in `readSettledState`,
  and `readHumanReviewPendingInterrupt`.

### Replacement 2: review resumes on the same chain

- `interrupt.resume` carries review decisions and review cancel; the Host has
  one resume entry point.
- The new-input policy moves to the Runtime; the Host's inline refusal of
  text over a pending review is replaced by consulting it.
- `handleRunInterrupt` keeps its inflight and resident-run branches. When
  neither matches, it re-emits `interrupt.requested` for the pending
  interrupt, as the Host section specifies. The TUI reconciles to it.
- Error codes become `interrupt_*`.
- TUI and Studio Console switch in the same change.
- Delete in the same change: `human_review_response`, `review.cancel`,
  `handleHumanReviewResponse`, `handleReviewCancel`, the review branch of
  `handleRunInterrupt`, the `review_*` error codes.

### Replacement 3: abort raises a pause

- #754. An aborted invocation that left unfinished task work ends as a
  `pause_task` interrupt with an id. An abort with nothing to continue stays
  `interrupted`. Where the interrupt is raised and how it re-enters are
  Runtime-private. Nothing above the Runtime changes, which is the test that
  Replacements 1 and 2 were done right.

## Required behavioral coverage

- A `human_review` and a `pause_task` interrupt project through the same Host
  function with an id, and resume through the same client message.
- A person's reply travels the Host as `{ interruptId, value }` and is turned
  into a LangGraph `Command` only at the graph service's adapter boundary. No
  handler builds an id-keyed resume map, and the Host does not read `value`.
- An unknown interrupt payload fails loudly at the Host, never silently
  reports "no interrupt".
- A pause is visible to a reconnecting client with its id, from the snapshot
  alone.
- A `chat_request` over a pending review is refused by the Runtime's policy;
  over a pending pause it supersedes and the unfinished delegation is
  detached without fabricating a handoff.
- A review-origin pause and an abort-origin pause are indistinguishable above
  the Runtime and continue through the same resume value.
- An abort that leaves no unfinished task work finalizes as `interrupted`
  and raises no interrupt.
- A `run.interrupt` that arrives after the run has settled into an interrupt
  re-emits that interrupt with its id, aborts nothing, and resolves nothing;
  the interface reconciles to it.
- No handler, adapter, or projection code outside the Runtime and the
  interface renderers compares `payload.kind` to a literal.

## Non-goals

- Changing review decision semantics, batch behavior, or authorization
  scopes. Those stay in [review.md](review.md).
- A third interrupt kind. The chain must not need to change for one, which is
  the test of this design, but none is planned.
- Studio-specific interrupt surfaces beyond consuming the same protocol.
