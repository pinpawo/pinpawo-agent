# Local-agent session projection

`LocalAgentSession` is the client-neutral, in-memory projection consumed by the local TUI and hosted chat adapter. It is not a second durable conversation store.

## Domain model

The four terms below describe different things and must not be used interchangeably:

- **Checkpoint** is the durable authority. LangGraph owns durable conversation messages and pending continuation state in checkpoints.
- **Snapshot** is a materialized value of a defined scope at one checkpoint point. A snapshot does not imply recovery, reconciliation, startup, or any other use by itself.
- **Timeline** is the ordered UI container used to present a session.
- **Timeline state** is the current mutable instance of that container. Runtime and control events may update it between checkpoint points.

The current local-agent snapshot endpoint selects a session/thread and materializes its latest checkpoint point together with current local runtime facts. Its checkpoint coordinate is implicit in that endpoint today. Historical point lookup may expose an explicit checkpoint coordinate later, but that is not part of this contract.

## Lifecycle

```text
checkpoint Cn
    -> snapshot(Cn)
    -> timeline state
    -> live runtime/control events mutate timeline state
    -> message.completed commits checkpoint Cn+1
    -> snapshot(Cn+1) replaces timeline state
```

Using the latest snapshot to replace timeline state after `message.completed` is intentional. Operation and subagent entries that exist only in the live timeline state may disappear at that point because they are not part of the checkpoint snapshot. They are session-scoped presentation state, not durable history. Reconstructing execution detail from checkpoint history is a separate future capability.

Startup, reconnect, resume, completion, and review-state refresh are reasons a client may apply a snapshot. They are not different kinds of snapshot and do not change what a snapshot means.

## Shape

A session owns one ordered timeline and zero or one active run. Local snapshot readers accept only the current versioned `LocalAgentSessionSnapshot`; the previous `runs[] + activeRunId`, legacy pending-review payloads, and message-only restore shapes are unsupported.

Partial `ReviewDraft` decisions are client-local interaction state and are not part of the shared snapshot.

Live TUI actions carry `LocalAgentSessionMessageInput` directly; there is no
second `MessageCell` model. Message `createdAt` / `updatedAt` values use ISO
timestamps in state, and terminal-local time formatting happens only while
rendering.

## Local snapshot transport

- `/snapshot` returns the current versioned snapshot for the active session.
- `/sessions/resume` switches the active thread and returns its current versioned snapshot.
- There is no `/history` restore endpoint or message-only fallback.
- The server reads one LangGraph checkpoint point and derives both checkpoint messages and pending review state from it before building the snapshot.
- The snapshot contains current runtime facts; the client does not compose it from a second `/runtime` request.

## Shared reduction

`reduceSession(session, input, { observedAt })` is the deterministic, client-neutral transition boundary for accepted user input, runtime events, review actions, interrupt state, and terminal run state. Callers supply observation time explicitly; the reducer does not read clocks, sockets, files, or UI state.

`applySessionSnapshot(session, snapshot, options)` replaces the ordered timeline and active run with the materialized snapshot value. Its options describe application policy, such as whether omitted token usage should retain a process-local observation; they do not classify the snapshot.

The TUI reducer adapts TUI actions and presentation text into these inputs. Composer history, focus, connection copy, partial review drafts, and viewport state remain TUI-owned and are not part of the shared projection.

## Hosted chat adapter

The hosted chat adapter folds accepted user input, runtime events, review actions, interrupts, and terminal state through the same reducer as the TUI. Runtime events rejected by the shared ownership rules are not forwarded to the hosted wire. The process-local projection evicts least-recently-updated idle sessions above its retention limit while always retaining active runs; the existing event and control wire protocol remains compatible and does not add session patches or revision numbers.

Before an operation event reaches either the hosted projection or the wire, the adapter removes `raw`. Hosted clients derive operation UI from `title`, `target`, `summary`, and `details`.

Pending chat reviews are durable in LangGraph checkpoints. If an in-memory review route is lost after a restart or websocket route change, the hosted adapter scans the actor's app-chat threads and reconstructs the route from checkpoint state. New clients identify the continuation with `actionId` (the checkpoint interrupt ID), which is also the concurrency and duplicate-protection key. A failed or interrupted resume releases its action claim and forces the next attempt to re-read the checkpoint. Legacy responses without `actionId` may recover by `reviewId` only when exactly one pending review matches and every candidate thread was readable; ambiguity or an incomplete scan fails closed. Decisions remain ordered as supplied by the review batch.

Studio review batching and backend persistence changes are outside this compatibility step.

Ink/React state, composer focus, viewport state, sockets, filesystem handles, and partial review drafts are outside this contract.
