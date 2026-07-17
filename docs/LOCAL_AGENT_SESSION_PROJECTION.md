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

A session owns one ordered timeline and zero or one active run. Snapshot version 2
represents that run as exactly one of three projection facts:

- `running` carries one runtime `activity`: `thinking`, `using_tool`, or `streaming`;
- `waiting_review` structurally carries its checkpoint-derived `ReviewAction`;
- `interrupting` means the server run controller has begun interruption.

The union cannot represent a running or interrupting run with review content, or
a waiting review without review content. The initial `running` / `thinking` view
is created only after the outbound run command is accepted by the transport.
Later activity changes come from server runtime events; elapsed-time presentation
such as busy-copy escalation remains in the render layer. Sending
`run.interrupt` does not optimistically create the `interrupting` view.

Local snapshot readers accept only the current versioned
`LocalAgentSessionSnapshot`; snapshot version 1, the previous
`runs[] + activeRunId`, legacy pending-review payloads, and message-only restore
shapes are unsupported.

Partial `ReviewDraft` decisions and the one-shot `resolutionSent` marker are
client-local interaction state and are not part of the shared snapshot.
`ReviewAction` contains only the checkpoint-derived batch identity and ordered
review specifications; it does not contain review-command progress.

Live TUI actions carry `LocalAgentSessionMessageInput` directly. The TUI no
longer defines a separate `MessageCell` model. Message `createdAt` / `updatedAt`
values use ISO timestamps in state, and terminal-local time formatting happens
only while rendering.

Direct domain-only mutations use canonical `LocalAgentSessionInput` variants as
TUI actions. Separate TUI action vocabulary remains for TUI-only state and where
a domain intent also changes composer, review-draft, ownership, or status-copy
state.

The TUI resolves one `TuiInteractionOwner` for each render from current
interaction state. Input routing and visible overlay selection both consume that
same owner. Their priority order lives only in `resolveTuiInteractionOwner`;
routers and render models must not infer a second owner from open-state flags.

TUI transport connection state contains only connection status and optional
transport detail. Current run and review activity is derived from the focused
session. Presentation copy that cannot be derived, such as a recovered error or
completed interrupt notice, lives in the focused TUI's separate `statusNotice`
field and must not be written into connection state or updated by background
session events.

## Local snapshot transport

- `/snapshot` returns the current versioned snapshot for the active session.
- `/sessions/resume` switches the active thread and returns its current versioned snapshot.
- There is no `/history` restore endpoint or message-only fallback.
- The server reads one LangGraph checkpoint point and derives both checkpoint messages and pending review state from it before building the snapshot.
- The snapshot contains current runtime facts; the client validates them at this boundary and does not compose them from a second `/runtime` request.

## Shared reduction

`reduceSession(session, input, { observedAt })` is the deterministic,
client-neutral transition boundary for accepted user input, server-observed
runtime events, interrupt state, and terminal run state. Sending a review
resolution does not mutate this shared projection; subsequent server events or
a snapshot provide the next shared fact. Callers supply observation time
explicitly; the reducer does not read clocks, sockets, files, or UI state.

`applySessionSnapshot(session, snapshot, options)` replaces the ordered timeline and active run with the materialized snapshot value. Its options describe application policy, such as whether omitted token usage should retain a process-local observation; they do not classify the snapshot.

The TUI reducer adapts TUI actions and presentation text into these inputs.
Composer history, focus, connection copy, partial review drafts, the one-shot
review-resolution send marker, and viewport state remain TUI-owned and are
not part of the shared projection. After a review resolution is sent and before
the next server fact arrives, that marker gates composer input and routes a
further interrupt request to `run.interrupt`; there is no cancellable
review-submission lifecycle. It is cleared when server-observed state diverges
from the waiting review action. A user-triggered run interrupt does not add a
separate client-side pending domain state.

The server preserves client command order through a server-local
`RunCommandSequencer`. If `run.interrupt` arrives while a preceding review
resolution is still being validated, the sequencer queues it behind that
resolution. Once the resumed run is registered, `run.interrupt` follows the
ordinary inflight interruption path even if checkpoint consumption has not yet
been confirmed. A queued interrupt is released only after a graph state boundary
confirms that the original pending review has been removed from the checkpoint;
registering an inflight run or observing an arbitrary stream event is not
sufficient. If that boundary contains a new pending review, the earlier
interrupt is consumed without canceling the new review. Sequencer state is
transport control state and is never
projected into `LocalAgentSession` or a snapshot. Long-running agent execution
does not block later client commands from entering the sequencer.

## Hosted chat adapter

The hosted chat adapter folds accepted user input, runtime events, server
interrupt progress, and terminal state through the same reducer as the TUI.
Review-resolution commands do not optimistically advance the hosted projection.
Runtime events rejected by the shared ownership rules are not forwarded to the
hosted wire. The process-local projection evicts least-recently-updated idle
sessions above its retention limit while always retaining active runs; the
existing event and control wire protocol remains compatible and does not add
session patches or revision numbers.

Before an operation event reaches either the hosted projection or the wire, the adapter removes `raw`. Hosted clients derive operation UI from `title`, `target`, `summary`, and `details`.

Pending chat reviews are durable in LangGraph checkpoints. If an in-memory review route is lost after a restart or websocket route change, the hosted adapter scans the actor's app-chat threads and reconstructs the route from checkpoint state. New clients identify the continuation with `actionId` (the checkpoint interrupt ID), which is also the concurrency and duplicate-protection key. A failed or interrupted resume releases its action claim and forces the next attempt to re-read the checkpoint. Legacy responses without `actionId` may recover by `reviewId` only when exactly one pending review matches and every candidate thread was readable; ambiguity or an incomplete scan fails closed. Decisions remain ordered as supplied by the review batch.

Studio review batching and backend persistence changes are outside this compatibility step.

Ink/React state, composer focus, viewport state, sockets, filesystem handles, and partial review drafts are outside this contract.
