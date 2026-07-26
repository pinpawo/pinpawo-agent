# Local-agent session projection

> **Current authority for this topic.** This document is the canonical contract.
> The synthesized, navigable knowledge layer over it lives at
> [`docs/wiki/local-agent-session-projection.md`](wiki/local-agent-session-projection.md).

`AgentSession` is the client-neutral, in-memory projection consumed by the local TUI and hosted chat adapter. It is not a second durable conversation store.

The canonical implementation lives in the runtime-neutral
`@pinpawo/agent-session` workspace package. `services/local-agent` produces and
serves the projection; clients such as the existing TUI consume it. Neither
transport nor UI implementation owns the domain model.

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

A session owns one ordered timeline and zero or one active run. Snapshot version 3
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
`AgentSessionSnapshot`. Snapshot versions 1 and 2 are unsupported, as are
the previous `runs[] + activeRunId`, legacy pending-review payloads, and
message-only restore shapes.

## Shared package and transport boundary

`AgentSessionSnapshot` is a versioned wrapper around the canonical
`AgentSession` projection. `createAgentSessionSnapshot` creates that value, and
the shared parser validates untrusted JSON at an input boundary. The shared
package does not maintain a second `Wire` object graph or a general-purpose JSON
serializer.

Disclosure policy belongs to the endpoint that knows its trust boundary. The
current local-agent remote adapter preserves native events and snapshots,
including deltas and operation `raw`, and only redacts obvious local path
fragments in main-agent `message.completed.text`. Trusted local transports
retain the canonical data unchanged. A future public API may use the same
snapshot contract while applying a stricter API-specific disclosure policy.

Runtime/checkpoint-to-snapshot materialization remains a local-agent adapter.
WebSocket, stdio, HTTP, future API routes, authentication, persistence and
pagination remain outside the shared package. Remote APIs adapt the shared
snapshot contract instead of defining a third session model.

Partial `ReviewDraft` decisions and the one-shot `resolutionSent` marker are
client-local interaction state and are not part of the shared snapshot.
`ReviewAction` contains only the checkpoint-derived batch identity and ordered
review specifications; it does not contain review-command progress.

Live TUI actions carry `AgentSessionMessageInput` directly. The TUI no
longer defines a separate `MessageCell` model. Message `createdAt` / `updatedAt`
values use ISO timestamps in state, and terminal-local time formatting happens
only while rendering.

Direct domain-only mutations use canonical `AgentSessionInput` variants as
TUI actions. Separate TUI action vocabulary remains for TUI-only state and where
a domain intent also changes composer, review-draft, ownership, or status-copy
state.

The TUI names the destination for the next composer submission
`ui.composerTarget`. It is a UI routing choice (`chat | studio`), not the same
concept as `session.kind`, which classifies the focused session projection.
Commands that switch between Chat and Studio update both facts when appropriate,
but consumers must not derive one from the other.

The TUI intentionally retains `sessions + focusedSessionId`. Switchable/resumable
sessions are already a product capability, and session-keyed state keeps late or
background runtime events scoped to their owning session instead of allowing
them to mutate the focused session. The current terminal UI still renders one
focused session over one local connection; retaining the map does not imply
multiple visible panes or a second durable store. Background session events may
update their session projection but must not replace focused-session notices or
interaction state.

Timeline entries do not carry a required checkpoint/live/local-input provenance
field. That field had no production consumer, and the path by which an entry was
observed is not part of its canonical identity. A future debug/export feature
that needs provenance must define and consume its own explicit diagnostic
contract instead of making every timeline entry carry write-only metadata.

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

Token usage keeps two scopes explicit in the projection: `tokenUsage` is the
latest provider-reported run snapshot, while `sessionTokenUsage` accumulates
the runs observed by the current process for that session. Starting another
run clears only `tokenUsage`; clearing the session clears both. Snapshot
materialization reconstructs `sessionTokenUsage` from provider usage metadata
stored on the session's checkpoint messages, so reconnect and resume can restore
the cumulative value. When a provider or historical checkpoint has no usage
metadata, the field remains absent until a completed run reports usage.
`sessionTokenUsage.latestInputTokens` retains the latest provider prompt
footprint separately from cumulative input/output totals; the TUI uses it to
show remaining tokens before the shared 75% context-compaction watermark.

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
projected into `AgentSession` or a snapshot. Long-running agent execution
does not block later client commands from entering the sequencer.

## Invocation ownership and interruption

One graph invocation is the lifetime of one `graph.streamEvents()` call,
including settlement of its `GraphRunStream.output`. The server coordinates
invocations by graph thread:

- registering a replacement immediately aborts the preceding invocation;
- the replacement does not load context, project its user message, or call the
  graph until the predecessor has actually settled;
- a request superseded while queued never enters the graph;
- different threads remain independent and may execute concurrently, even when
  they share one WebSocket or stdio transport.

`ThreadInvocationCoordinator` owns this ordering rule.
`InflightRequestController` owns request-scoped abort controllers, operation
terminalization, and exact `requestId` interrupt routing for a transport. It
may therefore track multiple requests on one connection, but it does not decide
when another graph invocation may begin.

Abort is a signal, not a terminal fact. Neither server nor TUI releases a run
after an elapsed timeout. The invocation owner emits `interrupted` and clears
the inflight request only when execution returns or throws; disconnect only
signals all affected requests. Once a replacement owns the thread, callbacks
from the predecessor cannot project or forward late runtime events.

This lifecycle is intentionally separate from checkpoint semantics. LangGraph
continues to own checkpoint persistence and interrupted continuation state;
the local coordinator neither inspects checkpoint generations nor uses a
checkpoint as a lock.

## Hosted chat adapter

The hosted chat adapter folds accepted user input, runtime events, server
interrupt progress, and terminal state through the same reducer as the TUI.
Review-resolution commands do not optimistically advance the hosted projection.
Runtime events rejected by the shared ownership rules are not forwarded to the
hosted wire. The process-local projection evicts least-recently-updated idle
sessions above its retention limit while always retaining active runs; the
existing event and control wire protocol remains compatible and does not add
session patches or revision numbers.

Before a completed main-agent message reaches the current remote transport, the
local-agent adapter redacts obvious local path fragments in its `text`. This
narrow endpoint rule is not part of the shared projection contract. Other
events and snapshots retain their canonical payload, including operation
`raw`, title, summary, source, target, and details fields.

Pending chat reviews are durable in LangGraph checkpoints. If an in-memory review route is lost after a restart or websocket route change, the hosted adapter scans the actor's app-chat threads and reconstructs the route from checkpoint state. New clients identify the continuation with `actionId` (the checkpoint interrupt ID), which is also the concurrency and duplicate-protection key. A failed or interrupted resume releases its action claim and forces the next attempt to re-read the checkpoint. Legacy responses without `actionId` may recover by `reviewId` only when exactly one pending review matches and every candidate thread was readable; ambiguity or an incomplete scan fails closed. Decisions remain ordered as supplied by the review batch.

Studio review batching and backend persistence changes are outside this compatibility step.

Ink/React state, composer focus, viewport state, sockets, filesystem handles, and partial review drafts are outside this contract.
