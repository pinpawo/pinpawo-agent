# Review and Interrupt Runtime Design

> Status: Draft
> Date: 2026-09-04
> Related: issues #133, #675, #684, #721, and #747; PR #682
> Policy selection: [Toolkit HITL policy](toolkit-hitl-policy.md)
> Host boundary: [Resident Pet Host ports](resident-pet-host-ports.md)

## Purpose

The Agent has one execution lifecycle. It may be running, interrupted, resumed,
or finished. Review is not a second state machine: it is one concrete reason why
the execution is interrupted.

This document is the single design source for:

- the Runtime's typed interrupt abstraction;
- Review request and resolution semantics;
- the relationship between Review, task pause, and invocation cancellation;
- message-history rules for approve, reject, respond, and Esc/cancel;
- LangGraph, Pet Runtime, Host, session, and interface ownership;
- migration from the current Review middleware without changing the parent
  Planner/capability topology.

The policy that decides whether an action requires Review remains separate in
[Toolkit HITL policy](toolkit-hitl-policy.md).

## Decision

The proposed polymorphic interrupt abstraction is compatible with the current
code structure, with one hard boundary:

> Classes encapsulate Runtime behavior; only JSON-serializable data crosses a
> LangGraph state, checkpoint, stream, or Host boundary.

The current topology already provides the required insertion points:

- `ToolkitReviewMiddleware.afterModel` raises Review before tool execution;
- the child `createAgent` graph inherits the parent checkpointer and runnable
  configuration;
- an `afterModel` update can commit message changes before control reaches
  `afterAgent`;
- `afterAgent` can raise the next interrupt while the same child graph remains
  active;
- the parent capability and Planner see nothing until the child actually
  finishes.

Therefore the first implementation belongs entirely in `packages/pet-agent`.
It does not require a new Agent Session status, a `continuationAvailable` event
field, a Review completion reason, or a parent graph route.

## Execution lifecycle

There is only one lifecycle:

```text
running -> interrupted -> running -> ... -> finished
```

`ReviewInterrupt` and `PauseTaskInterrupt` describe the cause and resume
contract of an interruption. They are not lifecycle states.

The following terms are sufficient:

- **Agent interrupt**: a typed, durable LangGraph interrupt raised by Pet
  Runtime.
- **Review interrupt**: an Agent interrupt asking an external actor to decide a
  proposed action.
- **Pause-task interrupt**: an Agent interrupt retaining the unfinished child
  task until an explicit continue command arrives.
- **Invocation cancellation**: the Host aborting code that is currently
  running, such as a streaming model request. This stops an invocation but does
  not by itself create a durable LangGraph interrupt.

Review is important business behavior, but it remains a specialization of
Agent interrupt rather than an independent flow state.

## Runtime abstraction

### Behavior object

Pet Runtime owns a runtime-local interface or abstract base class:

```ts
type JsonObject = { [key: string]: JsonValue };

interface AgentInterrupt<
  TPayload extends JsonObject,
  TResume,
  TResolution,
> {
  readonly kind: TPayload['kind'];

  /** JSON-safe value passed to LangGraph interrupt(). */
  payload(): TPayload;

  /** Validates untrusted resume data and returns a Runtime value. */
  parseResume(value: unknown): TResume;

  /** Applies the business meaning of that resume. */
  resolve(resume: TResume): TResolution | Promise<TResolution>;
}
```

Concrete implementations may be classes:

```ts
class ReviewInterrupt implements AgentInterrupt<
  ReviewInterruptPayload,
  ReviewInterruptResume,
  ReviewInterruptResolution
> { /* ... */ }

class PauseTaskInterrupt implements AgentInterrupt<
  PauseTaskInterruptPayload,
  PauseTaskInterruptResume,
  PauseTaskInterruptResolution
> { /* ... */ }
```

The exact method names are implementation details. The important contract is
that each concrete interrupt owns:

- its serializable payload;
- validation of its accepted resume value;
- its business resolution;
- the Runtime transition produced by that resolution.

This replaces scattered `kind` switches and unrelated booleans with
polymorphism inside Pet Runtime. Host and interfaces still use discriminated
data because behavior cannot cross a process or checkpoint boundary.

A small Runtime helper performs the LangGraph bridge:

```ts
async function raiseAgentInterrupt<TPayload extends JsonObject, TResume, TResult>(
  definition: AgentInterrupt<TPayload, TResume, TResult>,
) {
  const rawResume = interrupt(definition.payload());
  return definition.resolve(definition.parseResume(rawResume));
}
```

The concrete class controls the meaning of resume. It does not send the resume
command from the Host side; only the Host that owns the active invocation can
adapt an accepted interface command to LangGraph `Command({ resume })`.

### Serialization boundary

An `AgentInterrupt` instance, method, function, closure, or service reference
must never be written to graph state or passed as an interrupt/resume payload.
Interrupt and resume payloads are plain JSON data. LangChain `BaseMessage`
objects may remain in the graph's message channel, where the LangGraph
serializer already owns them, but must not appear in the public resume value.

Only descriptors such as these are persisted:

```ts
type AgentInterruptPayload =
  | ReviewInterruptPayload
  | PauseTaskInterruptPayload;

type ReviewInterruptPayload = {
  kind: 'review';
  reviews: ReviewRequestData[];
  error?: ReviewErrorData;
};

type PauseTaskInterruptPayload = {
  kind: 'pause_task';
};
```

On node replay, Pet Runtime deterministically reconstructs the appropriate
behavior object from ordinary graph state and the descriptor. LangGraph owns
the interrupt ID and namespace; Pet Runtime must not synthesize either.

The current `review` and `review_batch` payloads may remain wire-compatible
during migration. Internally they should normalize to one `ReviewInterrupt`
whose `reviews` array has one or more items.

### Why one deferred descriptor is necessary

LangGraph does not commit a node's state update when that same node calls
`interrupt()` before returning. Reject and Esc must first commit their message
transition, then interrupt in the next superstep.

The middleware therefore needs one small, private, serializable handoff:

```ts
type ReviewMiddlewareState = {
  deferredInterrupt: PauseTaskInterruptPayload | null;
};
```

This is not a global `task paused` state and not another state machine. It is a
one-superstep instruction:

1. Review resolution returns message updates plus
   `deferredInterrupt: { kind: 'pause_task' }`.
2. LangGraph commits that update.
3. `afterAgent` reconstructs `PauseTaskInterrupt` and raises it.
4. On continue, LangGraph replays `afterAgent`; the interrupt returns the resume
   value, then the hook clears the descriptor and routes to the same child
   model.

The descriptor replaces the current `toolkitReviewPausePending` boolean. The
typed value says what must happen next and remains extensible without adding a
new boolean for every interrupt kind.

## Concrete interrupts

### ReviewInterrupt

`ReviewInterrupt` owns the full Review interaction. Its payload contains the
runtime-held Review definitions needed to validate a response. The Host
projects only presentation-safe fields to an interface.

Its resume contract has two semantic variants:

```ts
type ReviewInterruptResume =
  | {
      action: 'respond';
      responses: ReviewResponseData[];
    }
  | {
      action: 'cancel';
    };
```

The existing `{ action: 'interrupt_run' }` value should be treated as migration
compatibility only. It is a Review cancellation, not a command to terminate the
whole run. Naming it `cancel` prevents the resume parser from leaking Host
lifecycle vocabulary into Review business logic.

The result should be a discriminated Runtime transition rather than the
current combination of `resumeModel`, `rollbackAction`, and `pauseTask`
booleans. For example:

```ts
type ReviewInterruptResolution =
  | { type: 'execute'; authorizations: AuthorizationEffect[] }
  | { type: 'continue_model'; messages: BaseMessage[] }
  | {
      type: 'defer_interrupt';
      messages: BaseMessage[];
      interrupt: PauseTaskInterruptPayload;
    }
  | { type: 'finish'; messages: BaseMessage[] };
```

`finish` is reserved for policy or guard outcomes that genuinely finish the
child. Reject and Esc never resolve to it.

### PauseTaskInterrupt

`PauseTaskInterrupt` means that the current child task is unfinished and may
continue from its current committed history. It does not carry Review data and
does not produce a Review UI.

Its resume contract is explicit and JSON-safe:

```ts
type PauseTaskInterruptResume = {
  action: 'continue';
  guidance?: string;
};
```

Pet Runtime constructs a `HumanMessage` from validated guidance. The public
resume value must not contain a LangChain `BaseMessage` instance.

Resolution clears the deferred marker and routes directly to the same child
model. It does not return through capability finalization, Planner, delegation
handoff, or a new subagent invocation.

## Review semantics

### Approve

Approve authorizes the reviewed action. Once every required item in an atomic
batch is approved, the original tools execute and the child loop continues.

```text
ReviewInterrupt
  -> approve
  -> execute reviewed tool calls
  -> append real ToolMessages
  -> continue child
```

An approve option may apply only the authorization effects declared by the
runtime-held Review definition.

### Reject

Reject is a semantic decision: the actor saw the proposed action and declined
it. The history must preserve that fact.

For the complete AI tool-call action:

- keep the AI message containing all proposed tool calls;
- execute none of the raw tools;
- append one terminal `ToolMessage` for every tool-call ID;
- mark the selected action as rejected, including its reason when available;
- mark the remaining calls as cancelled with the rejected atomic batch;
- defer a `PauseTaskInterrupt`.

```text
AI(tool calls)
  -> ReviewInterrupt
  -> reject
  -> ToolMessage(rejected: reason)
  -> ToolMessage(cancelled with batch) ...
  -> commit
  -> PauseTaskInterrupt
```

These protocol-complete tool results are rejection guidance. No separate
`rejectionGuidance` state is needed. When continued, the same child model sees
what it proposed and why it was rejected.

### Respond

Respond supplies requested information instead of authorizing the proposed
action. The raw tools do not execute. Pet Runtime appends protocol-complete
synthetic tool results containing the response, then routes directly to the
same child model.

Respond is neither rejection nor task pause unless a future Review option
explicitly declares another resolution.

### Esc or Review cancellation

Esc/cancel closes the Review without deciding that the proposed action was
wrong.

- execute none of the raw tools;
- remove the complete, unexecuted AI tool-call message;
- append no rejection ToolMessage;
- restore the child lane to the committed boundary before that proposal;
- defer a `PauseTaskInterrupt`.

```text
AI(tool calls)
  -> ReviewInterrupt
  -> cancel
  -> RemoveMessage(AI tool-call action)
  -> commit
  -> PauseTaskInterrupt
```

Continuing without guidance may cause the model to propose the same action
again. That is correct because cancellation supplied no negative guidance.

### Invalid or stale response

An unknown option, invalid option input, mismatched Review ID, stale interrupt
ID, wrong namespace, or wrong session must not mutate graph state.

The Host rejects identity mismatches before resume. `ReviewInterrupt` rejects
invalid resume data. If the error is recoverable, the Runtime may raise the
same Review again with JSON-safe error presentation; it must not silently
convert invalid input into Reject or Esc.

## Atomic batch rules

One AI message may contain multiple tool calls. Review of that action is
atomic:

- no reviewed call executes until every required response validates;
- approval executes the approved batch;
- one rejection prevents every call in the action from executing;
- rejection produces one terminal result for every tool-call ID;
- Esc removes the complete AI action rather than editing individual calls;
- authorization effects apply only after the complete batch validates.

These rules prevent partial side effects and preserve provider tool-call
protocol ordering.

## LangGraph control flow

### Review to task pause

Reject and Esc consume the original Review interrupt, but consuming an
interrupt is not completion. The child must perform this exact sequence:

```text
ReviewInterrupt
  -> resume
  -> resolve Review
  -> return message update + deferred PauseTaskInterrupt descriptor
  -> commit superstep
  -> afterAgent raises PauseTaskInterrupt
```

There must be no model call, Planner call, capability finalization, delegation
announce/handoff, or observable child completion between the two interrupts.

In the current LangChain `createAgent` graph, `jumpTo: 'end'` from `afterModel`
is an internal route to the configured `afterAgent` hook. It is acceptable as
the bridge above; it must not be confused with the child graph reaching an
observable `END`. If that framework mapping changes, tests must fail before
the Runtime can accidentally finalize the child.

### Replay and idempotency

LangGraph resumes an interrupted node by running the node again from its
beginning. Nested child graphs may also replay parent work. Therefore:

- Review policy lookup before `interrupt()` must be deterministic and
  side-effect free;
- authorization effects must be idempotent or applied only after validated
  resume;
- tool execution must occur only after approval and exactly once;
- class construction must be pure;
- logic must not depend on object identity surviving replay;
- the Host must resume the exact LangGraph interrupt ID/namespace it observed.

The current use of private Pregel scratchpad fields to detect a resume is
technical debt. Non-deterministic automatic Review work should eventually be a
checkpointed LangGraph task or separate node, not a dependency of the typed
interrupt abstraction.

## Running Esc and invocation cancellation

Esc while a model or tool is actively running is not a `ReviewInterrupt` or a
`PauseTaskInterrupt`. The Host cancels the current invocation using its
`AbortSignal`.

For an ordinary streaming model call:

- streaming stops;
- the unfinished node does not commit a partial AI message;
- no Review decision or ToolMessage is invented;
- no class instance or completion reason is stored.

Cancellation alone does not manufacture a pending LangGraph `interrupt()`.
After cancellation, the Host reads the settled graph snapshot:

- if LangGraph reports a pending typed interrupt, the task is interrupted and
  its payload determines the available interaction;
- if the graph has pending `next/tasks` but no typed interrupt, resumability is
  derived from that graph state according to the existing Runtime path;
- if neither exists, the invocation stopped at its last committed boundary and
  the next user message is a new input.

If product semantics later require every running Esc to create a durable
`PauseTaskInterrupt`, that requires a controlled graph node boundary. It is a
separate Runtime feature; the Host must not fake it by resuming or editing a
checkpoint.

## Layer ownership

### Toolkit policy

Toolkit policy decides whether a tool action executes automatically, requires
Review, is blocked, or is covered by an existing authorization. It does not own
interrupt control flow or interface behavior.

### Pet Runtime

Pet Runtime owns:

- `AgentInterrupt`, `ReviewInterrupt`, and `PauseTaskInterrupt` behavior;
- serializable payload and resume validation;
- Review decision/effect resolution;
- message-history updates;
- the one-superstep deferred interrupt descriptor;
- routing back to the same child model.

It does not emit a Review-specific subagent completion reason and does not ask
Planner to stop the task.

### LangGraph

LangGraph owns:

- interrupt persistence;
- interrupt IDs and namespaces;
- checkpoint writes and replay;
- resume delivery;
- graph task/next state.

Pet Runtime and Host use LangGraph APIs. Neither talks directly to the
checkpointer for Review control flow.

### Host adapter

The Host owns:

- invocation cancellation;
- reading current graph state through the graph API;
- correlating session, interrupt ID, and namespace;
- projecting a typed payload to a supported interface interaction;
- adapting an accepted semantic command to `Command({ resume })`;
- rejecting stale or mismatched commands without resuming the graph.

The Host switches only at the transport boundary to select an adapter for
`payload.kind`. Review and pause business semantics remain in the concrete Pet
Runtime class.

### Agent Session

Agent Session records public events and interface-safe pending interactions. It
does not own the Runtime lifecycle and must not receive Pet Runtime classes,
LangGraph commands, checkpoint data, or internal transition objects.

No `continuationAvailable` field is required. Whether work remains is derived
from current LangGraph `next/tasks` and pending interrupts. If a future shared
interface must display `PauseTaskInterrupt`, the existing pending-interrupt
projection can be generalized by `kind`; this is preferable to adding a second
boolean that can disagree with graph state.

The Pet Runtime refactor can be completed and tested before that protocol
generalization.

### Interaction interfaces

An interface renders the interaction selected by the pending payload kind:

- `review` renders Review options and declared inputs;
- `pause_task` renders a continue affordance with optional guidance.

Interfaces send semantic commands only. They never construct LangGraph
`Command`, select graph nodes, pass `activeDelegationTransition`, or interpret
internal Review effects.

Chat, TUI, App, Studio, and future remote approval surfaces may present the
same payload differently, but they return the same identity-based response.
Unsupported required Review capabilities fail closed.

## Compatibility with the current implementation

The refactor maps onto existing code without changing the parent execution
topology:

| Current implementation | Target design |
| --- | --- |
| `afterModel` calls `interrupt(reviewPayload)` | `afterModel` raises reconstructed `ReviewInterrupt` |
| `resolveHumanToolkitReviews` and response helpers | `ReviewInterrupt.parseResume/resolve` |
| `{ action: 'interrupt_run' }` | migration alias for `{ action: 'cancel' }` |
| `resumeModel`, `rollbackAction`, `pauseTask` booleans | `ReviewInterruptResolution` union |
| `toolkitReviewPausePending: boolean` | `deferredInterrupt: PauseTaskInterruptPayload \| null` |
| `afterAgent` calls `interrupt(null)` | `afterAgent` raises `PauseTaskInterrupt` with typed payload |
| resume contains `BaseMessage \| null` | JSON-safe continue command; Runtime builds the message |
| child `completionReason: 'interrupted'` | removed; child has not completed |
| capability/Planner special interrupt route | removed; parent is not entered while child is interrupted |

The abstraction is deliberately local to Pet Runtime. `createSubagent` still
creates the child graph, the capability still awaits it, and Planner still runs
only after an actual child result.

## Implementation sequence

### Phase 1: Pet Runtime

1. Add the runtime-local `AgentInterrupt` contract and JSON-safe payload guards.
2. Wrap current Review payload parsing and resolution in `ReviewInterrupt`.
3. Add `PauseTaskInterrupt` with a typed continue resume.
4. Replace Review-result booleans with a discriminated resolution.
5. Replace `toolkitReviewPausePending` with the private deferred descriptor.
6. Preserve `review`/`review_batch` and `interrupt_run` only as migration input
   where current Host tests require them.
7. Keep parent capability, Planner, subagent completion, and Agent Session
   untouched.

### Phase 2: Host and interface projection

1. Teach the graph-state reader to retain every supported typed interrupt,
   including its LangGraph ID and namespace.
2. Keep the existing Review projection behavior.
3. Project `pause_task` as a continue interaction or existing interrupted-task
   affordance.
4. Build the correct JSON-safe resume from the semantic interface command.
5. Remove migration aliases after all active interfaces use the new commands.

If shared Agent Session protocol changes are necessary, make them only in this
phase and generalize `PendingInterruptProjection`; do not add a derived
continuation flag.

### Phase 3: running cancellation, if required

Define whether a canceled running node should remain merely canceled at its
last checkpoint or enter a durable `PauseTaskInterrupt`. Implement the latter
inside the graph only if the product requires it.

## Required behavioral coverage

### Runtime unit/integration tests

- payloads and resumes are JSON-serializable;
- class instances never appear in state or checkpoint values;
- approve executes every approved tool exactly once;
- reject executes no tool and records one terminal result per tool-call ID;
- Esc executes no tool and removes the whole AI tool-call action;
- respond returns to the same child with protocol-complete synthetic results;
- Reject and Esc commit their history before `PauseTaskInterrupt` appears;
- the pause interrupt has a different LangGraph interrupt ID from Review;
- no model, Planner, finalize, announce, or handoff occurs between interrupts;
- continue with and without guidance resumes the same child model;
- replay or process-style graph reconstruction resumes the correct child;
- invalid resume data leaves the active interrupt unresolved;
- deterministic policy blocks retain their genuine terminal semantics.

### Host and protocol tests

- the exact interrupt ID and namespace are required for resume;
- stale, wrong-session, wrong-kind, and duplicate responses do not mutate state;
- reconnect projects current graph state rather than adapter-local memory;
- `review` and `pause_task` produce different interaction affordances;
- no continuation boolean is persisted independently of graph state;
- running cancellation commits no partial model message;
- unsupported Review capabilities fail closed.

## Non-goals

- A separate Review state machine.
- Persisting interrupt class instances or Runtime services.
- Reading or editing checkpoint storage directly.
- Using subagent `completionReason` to represent Review or pause.
- Routing through Planner merely to stop or pause a child.
- Treating consumption of one interrupt as child completion.
- Treating internal `jumpTo: 'end'` as observable graph completion.
- Letting interfaces send internal decisions, effects, graph nodes, delegation
  transitions, or LangGraph resume values.
- Adding a `continuationAvailable` field that duplicates graph-derived state.
- Making TUI overlay state, Chat identity, or Studio dispatch identity part of
  the Runtime Review contract.
