# Interrupt Domain

> Status: Draft
> Date: 2026-09-07
> Related: issues #675, #747, #754, #756; PRs #682, #758, #766, #767, #770
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
5. **Esc means abort a running run.** It has no meaning for a pending
   interrupt. What Esc does while an interrupt is pending is an interface
   decision that produces a resume value or a local UI transition.

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
  boundary; pause raises at the root `pauseGate` node after the capability
  node has committed the pending delegation. Both surface in the root
  snapshot's `interrupts[]`.
- A kind also declares its **new-input policy**: what happens if a fresh
  `chat_request` arrives while it is pending. `human_review` refuses (the
  reviewed tool call must be answered; the Host re-raises the same interrupt).
  `pause_task` supersedes (LangGraph drops the pending gate and the Runtime's
  default transition detaches the unfinished delegation). The Host asks the
  Runtime for this policy; it does not branch on the kind literal.
- Successive `interrupt()` calls in one task share an id. A kind therefore owns
  one task; a resolution that leads to another kind unwinds to that kind's own
  node rather than interrupting again in place. This is why a review
  rejection ends the subagent and lets `pauseGate` raise the pause.

### Host

- `readPendingInterrupt(snapshot)` returns `{ interruptId, payload }` for any
  recognized kind and throws for an unknown payload. It never returns `null`
  for an interrupt it does not understand.
- Settlement after a turn is one of four states. `waiting` covers every
  pending interrupt. `interrupted` is reserved for an aborted run.
  `waiting_human` and `paused` do not exist.
- The resident Host's dispatch admission reads the same function: a pending
  interrupt of any kind holds dispatch as `waiting`.
- The Host resumes by building `Command({ resume: { [interruptId]: value } })`
  from the client message unchanged. It validates identity (session, id) and
  nothing about the value.
- Finalization of an interrupted run is one path, described in #770: close
  operations, publish `run.interrupted`, clear the inflight run.

### Protocol

Runtime events:

- `interrupt.requested { requestId, interruptId, payload }` replaces
  `human_review.requested`. The payload is the kind's interaction payload.
- Error codes `interrupt_closed`, `interrupt_stale`, `interrupt_wrong_session`
  replace the `review_*` codes.

Client messages:

- `interrupt.resume { requestId, interruptId, value }` replaces
  `human_review_response` and `review.cancel`.
- `chat_request` loses `activeDelegationTransition`. A message is a message;
  whether it continues or supersedes is decided by the pending interrupt's
  new-input policy in the Runtime (#756).
- `run.interrupt { requestId }` stays and means abort the running run.

Snapshot projection:

- `pendingInterrupt { interruptId, payload }` for every kind. The
  `interruptId` is required. `readHumanReviewPendingInterrupt` and the
  id-less `pause_task` projection variant are removed.

### Interface

- Renders by `payload.kind`. Builds the resume value by kind:
  review decisions and review cancel per [review.md](review.md); pause
  continue as `{ action: 'continue', guidance? }`.
- Esc while running sends `run.interrupt`. Esc with a pending review sends
  `interrupt.resume` with the cancel value. Esc with a pending pause is a local
  exit from paused mode, as [delegation-pause-interaction.md](../tui/delegation-pause-interaction.md)
  already specifies; the next message supersedes through the Runtime.
- The composer is unavailable while a `human_review` interrupt is pending and
  available while a `pause_task` interrupt is pending. That is the only place
  an interface consults the kind for input policy, and it is a UX choice, not
  the enforcement point.

## Esc

```text
running  -- Esc --> run.interrupt --> abort --> run.interrupted
pending human_review -- Esc --> interrupt.resume(cancel) --> resume by id
pending pause_task   -- Esc --> local exit of paused mode
```

The Host's `handleRunInterrupt` therefore has two branches: an inflight Chat
run, or a resident Host run. The current third branch, which recovers a
pending review and cancels it on the interface's behalf, moves to the
interface. The Host must not turn one request type into another.

An aborted run that leaves unfinished work must end as a `pause_task`
interrupt with an id, so that continuation is the same resume-by-id as every
other case. The mechanism is Runtime-private and is the open design point of
#754; a candidate is to settle the abort by invoking the root graph toward
`pauseGate`, so the gate raises the interrupt against the last committed
delegation state. Until that lands, an aborted run with retained work is not
continuable through this domain and interfaces must not pretend it is.

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

## Migration sequence

Each phase generalizes the review path into the interrupt path. No phase adds
a pause-specific channel. Prerequisites: #766, #767, #770 merged.

### Phase 1: Host reads and settles by id

- `readPendingInterrupt` recognizes every kind; unknown payloads throw.
- Settlement gains `waiting` and drops `waiting_human` and `paused`.
- `readSettledState` in the resident Host reads interrupts only.
- The Chat handler's `paused` branch and the adapter's `pauseTaskInterrupt`
  read are removed.
- Legacy events are still emitted from the new read path so interfaces keep
  working unchanged.

### Phase 2: Protocol carries the domain

- Add `interrupt.requested`, `interrupt.resume`, the `interrupt_*` error
  codes, and the required `interruptId` on every `pendingInterrupt`.
- The parser accepts the legacy messages and canonicalizes them into the new
  shapes, the same approach #682 used for identity aliases.
- The Runtime exposes the new-input policy; the Host consults it instead of
  its inline review refusal.

### Phase 3: Interfaces speak the domain

- TUI, Studio Console, and the macOS companion send `interrupt.resume` for
  review decisions, review cancel, and pause continue.
- `continuePausedTask` sends the pause continue value by id.
  `activeDelegationTransition` is no longer sent.
- Esc semantics per the Esc section. The TUI's paused-mode local exit is
  already in place.

### Phase 4: Delete the legacy chain

- Protocol: `human_review.requested`, `human_review_response`,
  `review.cancel`, `chat_request.activeDelegationTransition`,
  `LegacyActiveDelegationTransition`, the `review_*` error codes.
- Host: `handleHumanReviewResponse`, `handleReviewCancel`, the review branch of
  `handleRunInterrupt`, `hasPendingContinuation`,
  `readHumanReviewPendingInterrupt`.
- Runtime: the `taskPauseInterrupt` state channel; `resume_active` and the
  externally settable `runActiveDelegationTransition`. The supersede
  transition remains as the Runtime-internal default.

### Phase 5: Running Esc raises a pause

- #754. An aborted run with unfinished work becomes a `pause_task` interrupt
  with an id. Continuation is then identical to a review-origin pause.

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
- Esc while running aborts and finalizes once; Esc with a pending review
  resolves that review by id; Esc with a pending pause sends nothing.
- No handler, adapter, or projection code outside the Runtime and the
  interface renderers compares `payload.kind` to a literal.

## Non-goals

- Changing review decision semantics, batch behavior, or authorization
  scopes. Those stay in [review.md](review.md).
- A third interrupt kind. The chain must not need to change for one, which is
  the test of this design, but none is planned.
- Studio-specific interrupt surfaces beyond consuming the same protocol.
