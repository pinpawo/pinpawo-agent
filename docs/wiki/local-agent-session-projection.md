---
title: Local-Agent Session Projection
page_type: system
status: validated
updated: 2026-08-22
sources:
  - ../../packages/agent-session/src/domain.ts
  - ../../packages/agent-session/src/project.ts
  - ../../packages/agent-session/src/parser.ts
  - ../../packages/agent-session/src/snapshot.ts
  - ../../packages/agent-contracts/src/interaction.ts
  - ../../packages/pet-agent/src/agent/orchestrator/review/reviewSpec.ts
  - ../../services/local-agent/src/localAgentSessionSnapshot.ts
  - ../design/local-agent/pending-interrupt-chat.md
  - ../../services/local-agent/src/inflightRequestController.ts
  - ../../services/local-agent/src/chatSessionAdapter.ts
  - ../../services/tui/src/session/sessionController.ts
  - ../../services/local-agent/src/localServerStdioTransport.ts
  - https://github.com/pinpawo/pinpawo-agent/issues/355
  - https://github.com/pinpawo/pinpawo-agent/issues/377
  - https://github.com/pinpawo/pinpawo-agent/issues/385
  - https://github.com/pinpawo/pinpawo-agent/issues/386
  - https://github.com/pinpawo/pinpawo-agent/issues/390
  - https://github.com/pinpawo/pinpawo-agent/pull/468
  - https://github.com/pinpawo/pinpawo-agent/pull/475
  - https://github.com/pinpawo/pinpawo-agent/pull/481
  - https://github.com/pinpawo/pinpawo-agent/pull/485
  - https://github.com/pinpawo/pinpawo-agent/issues/570
  - https://github.com/pinpawo/pinpawo-agent/pull/572
related:
  - agent-boundary-contracts.md
  - interruption-and-delegation-continuation.md
  - concepts/checkpoint-snapshot-timeline.md
  - concepts/session-projection-ownership.md
  - concepts/local-agent-transport-boundary.md
  - decisions/run-view-discriminated-union.md
  - decisions/review-resolution-is-client-local.md
  - concepts/studio-pet-thread-dispatch-invocation.md
  - questions/session-projection-open-questions.md
---

# Local-Agent Session Projection

## What this system is

`AgentSession` is one client-neutral, in-memory projection of a conversation,
consumed by the local TUI and the hosted chat adapter. It is **not** a second
durable conversation store — LangGraph checkpoints remain the durable authority.
This page is the current navigable synthesis over the shared
`@pinpawo/agent-session` implementation and the checkpoint-backed local host.

The projection replaced several overlapping, TUI-specific session and snapshot
shapes with one shared model (Decision, issue #355). A session owns one ordered
timeline, zero-or-one active invocation, and zero-or-one pending interrupt. The
shared reducer that transitions it has
no Ink, React, WebSocket, filesystem, singleton, or wall-clock dependency
([`project.ts`](../../packages/agent-session/src/project.ts)).

## How the pieces fit

```text
LangGraph checkpoint  (durable authority)
   │  materialize one checkpoint point + current runtime facts
   ▼
AgentSessionSnapshot  (versioned point value; v5)
   │  applySessionSnapshot()
   ▼
AgentSession  (timeline + zero/one activeRun + zero/one pendingInterrupt)
   ▲  reduceSession(session, input, { observedAt })
   │
server-observed runtime/control events + accepted user input
```

- **Shared reducer** — `reduceSession` and `applySessionSnapshot` in
  [`project.ts`](../../packages/agent-session/src/project.ts).
  Both the TUI and the hosted adapter fold their inputs through the same reducer.
- **Wire/snapshot parser** — transport-neutral parsing lives in
  [`parser.ts`](../../packages/agent-session/src/parser.ts),
  reused by the HTTP client and the stdio session commands rather than duplicated
  per client.
- **Server-local interrupt resume** — the Chat handler reloads the implicit
  active thread checkpoint for each response, then thread invocation
  serialization orders resume and cancel calls. No second review existence or
  consumed-state machine is projected or persisted.
- **Transport adapters** — WebSocket and JSONL stdio both attach to the same
  composed handlers behind a `LocalServerPeer` identity; no transport concept
  enters the session model.

## The four domain terms (must stay distinct)

See [Checkpoint, snapshot, timeline, and timeline state](concepts/checkpoint-snapshot-timeline.md).
Briefly: **checkpoint** is durable authority; **snapshot** is a materialized
point value with no inherent recovery meaning; **timeline** is the ordered UI
container; **timeline state** is its current mutable instance. Applying a
snapshot after `message.completed` intentionally replaces live-only operation and
subagent entries — they are session-scoped presentation state, not durable
history.

## Active invocation and pending interrupt

Snapshot version 5 represents the active invocation as a discriminated union of
two facts — `running(activity)` and `interrupting`. The checkpoint wait is the
separate nullable `pendingInterrupt` fact. A response/cancel starts a new active
invocation while retaining that wait until authoritative runtime progress. See
[Active invocation and pending interrupt](decisions/run-view-discriminated-union.md).

## Ownership boundaries

What is shared/server-observed versus TUI-local versus server transport-control
is deliberately partitioned. See
[Session projection ownership boundaries](concepts/session-projection-ownership.md)
and [Review resolution is client-local](decisions/review-resolution-is-client-local.md).

## Agent boundary contracts

**Fact (issue #570 / PR #572, revised by PR #682).** A
`PendingInterrupt` has one `interruptId` and a typed payload. For human review,
`payload.kind === 'human_review'` and `payload.interactions` contains public
`HumanReviewRequest` values from `@pinpawo/agent-contracts`, not internal
pet-agent `ReviewSpec` values. Presentation, input, and `batchSubmission` cross
the boundary; runtime decisions and effects remain checkpoint-owned. The V5
parser accepts the former V3 `waiting_review/reviewAction` and V4 embedded
`pending_interrupt` snapshots only as inbound compatibility shapes and
normalizes them immediately. See
[Agent boundary contracts](agent-boundary-contracts.md).

Every `activeRun` has a required `requestId`; `pendingInterrupt` has none. A
response/cancel command creates a new active run for its resumed invocation,
while interrupt and interaction identity remain `interruptId` and
`interactionId` respectively.

## Interruption and continuation

**Decision (PRs #475 and #485).** Interrupting the current invocation,
retaining an unfinished delegation in the checkpoint, and interpreting the next
user input are three separate transitions. The server emits terminal
`interrupted` only after graph output settles. Esc from `pending_interrupt` first
persists a canceled tool result and guard stop, then ends the invocation without
handoff while retaining the active delegation and its private lane.

Ordinary accepted input supersedes that active delegation and routes as a fresh
request. A causally eligible TUI can instead send `/continue <指导>`, which maps
to `resume_active` and reuses the retained lane. The process-local TUI marker
that controls command visibility is not a shared projection fact. See the full
[interruption and delegation continuation contract](interruption-and-delegation-continuation.md).

## Transport

The projection is transport-neutral. WebSocket and one-peer JSONL stdio both
carry the same typed messages, and snapshot/session/list/resume operations exist
on both the HTTP side channel and the stdio wire, backed by one server-side
implementation. See
[Local-agent transport boundary](concepts/local-agent-transport-boundary.md).

## Status of the work (as of 2026-07-28)

**Fact.** The projection refactor line is materially complete. Umbrella #355 and
its sub-issues #377, #385, #386, #390 are closed. The fresh-turn isolation,
review-interruption boundary, lane retention, and TUI continuation work from
PRs #475, #481, and #485 are also merged.

**Inference.** Open forward-looking concerns — a future public/API projection,
migrating the TUI's session operations from the HTTP side channel onto the wire
`session.*` channel, and snapshot version strategy once a third-party consumer
exists, plus whether continuation availability should survive a TUI process
restart — are collected in
[open questions](questions/session-projection-open-questions.md).
