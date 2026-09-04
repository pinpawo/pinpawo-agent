# Review and Interrupt Runtime Design

> Status: Draft
> Date: 2026-09-04
> Related: issues #133, #675, #684, #721, #747, and #749; PR #682
> Policy selection: [Toolkit HITL policy](toolkit-hitl-policy.md)
> Host boundary: [Resident Pet Host ports](resident-pet-host-ports.md)

## Purpose

The Agent has one execution lifecycle:

```text
running -> interrupted -> running -> ... -> finished
```

Review is not another lifecycle or state machine. It is one concrete reason why
execution is interrupted.

This document defines:

- the Runtime interrupt abstraction;
- the relationship between Review, task pause, and invocation cancellation;
- Review approve, reject, respond, and Esc semantics;
- message-history rules;
- continuation behavior;
- ownership across interfaces, Host, Pet Runtime, and LangGraph.

The policy that decides whether an action requires Review remains separate in
[Toolkit HITL policy](toolkit-hitl-policy.md).

## Decisions

Pet Runtime has two concrete interrupt concepts:

```text
AgentInterrupt
├── ReviewInterrupt
└── PauseTaskInterrupt
```

- `ReviewInterrupt` means that a proposed action is waiting for a decision.
- `PauseTaskInterrupt` means that execution stopped while the task is still
  unfinished and can be continued.

The two concepts have different interactions and different resume behavior,
but they describe the same `interrupted` lifecycle state.

The implementation follows these constraints:

- `ReviewInterrupt` uses LangGraph's dynamic `interrupt()` and typed resume
  data.
- Running Esc produces task-pause semantics: the Host cancels the active
  invocation, and Pet Runtime exposes `PauseTaskInterrupt` when unfinished work
  remains.
- Reject and Review Esc resolve the current `ReviewInterrupt`, commit their
  message transition, and request `PauseTaskInterrupt`.
- Whether task pause is materialized by another LangGraph `interrupt()` or by
  committing state and ending the current invocation is private to
  `PauseTaskInterrupt`. Review middleware, capability, Host, and interfaces do
  not choose that mechanism.
- The target implementation wraps non-deterministic Review policy work in a
  LangGraph `task()`, so resume restores its result instead of repeating it.
- Until the upstream nested-task replay fix is released, one isolated
  compatibility guard may inspect the current Pregel interrupt slot to skip the
  repeated policy call. This exception is tracked by issue #749 and must not
  become a Runtime or interface contract.
- Stopping a run is control flow, not a subagent completion reason.
- Pet Runtime does not read or edit checkpointer storage directly. It uses
  LangGraph graph APIs and ordinary Runtime state.
- Agent Session does not gain a derived `continuationAvailable` flag.

## Interrupt abstraction

Pet Runtime may implement each interrupt as a class or as an object satisfying
an internal interface. The abstraction owns behavior; only serializable data
crosses graph, checkpoint, stream, Host, or interface boundaries.

A minimal shape is:

```ts
interface AgentInterrupt<TInteraction, TTransition> {
  readonly kind: string;

  interaction(): TInteraction;
  resume(value: unknown): TTransition | Promise<TTransition>;
}
```

The exact method names are not a public contract. The important boundary is
that each concrete interrupt owns:

- the interaction projected to the caller;
- parsing and validation of the semantic command it accepts;
- the Runtime continuation needed for that interrupt kind.

Parsing is deliberately not a separate adapter responsibility. The LangGraph
node passes the raw value returned by `interrupt()` to the concrete interrupt's
single `resume()` entry point.

Class instances, methods, closures, and service references must never be
persisted. Pet Runtime reconstructs behavior objects from ordinary graph or
Runtime state.

### Code organization

Interrupt behavior has its own Runtime directory:

```text
packages/pet-agent/src/agent/orchestrator/
├── interrupt/
│   ├── agentInterrupt.ts
│   ├── reviewInterrupt.ts
│   ├── pauseTaskInterrupt.ts
│   └── index.ts
├── review/
│   ├── globalReviewPolicy.ts
│   ├── reviewAuthorizations.ts
│   ├── reviewPolicies.ts
│   ├── reviewResponseResolver.ts
│   └── reviewSpec.ts
└── toolkitReviewMiddleware.ts
```

The boundary is deliberate:

- `interrupt/agentInterrupt.ts` owns the internal behavior contract;
- `interrupt/reviewInterrupt.ts` owns Review interrupt/resume orchestration and
  the complete Approve, Respond, Reject, and Cancel outcome mapping, while
  reusing the Review payload guards owned by `review/`;
- `interrupt/pauseTaskInterrupt.ts` owns paused-task materialization,
  propagation across the child invocation boundary, its payload guard,
  state schema, interaction, and continue behavior;
- `review/` owns pure Review policy, specification, authorization, decision
  parsing, and message-construction helpers used by `ReviewInterrupt`;
- `toolkitReviewMiddleware.ts` connects the LangChain `afterModel` hook to the
  `ReviewInterrupt` adapter. It must not inspect raw Review decisions or
  independently branch on Approve, Respond, Reject, or Cancel.

`reviewRunControl.ts` is not moved into the new directory. Its interrupted
completion signal is removed rather than promoted into the interrupt model.
Tests for each concrete interrupt are colocated in `interrupt/`; policy and
message-resolution tests remain in `review/`.

### ReviewInterrupt

`ReviewInterrupt` is backed by a pending LangGraph dynamic interrupt. Its
serializable payload includes one or more Review requests:

```ts
type ReviewInterruptPayload = {
  kind: 'review_batch';
  reviews: ReviewRequestData[];
  error?: ReviewErrorData;
};
```

Its semantic commands are Review decisions:

```ts
type ReviewInterruptCommand =
  | { decisions: ReviewResponseData[] }
  | { action: 'cancel' };
```

The current `{ action: 'interrupt_run' }` value may remain as a migration alias
for Review cancellation. New code should call it `cancel`; it closes the Review
without pretending that the user made a rejection decision.

The Host resumes the exact LangGraph interrupt ID and namespace that it
observed. `ReviewInterrupt` validates the resume value and resolves its business
meaning.

`ReviewInterrupt.resume()` encapsulates the complete four-way outcome. The
result keeps the semantic decision explicit even when two decisions eventually
pause the task:

```ts
type ReviewInterruptResolution =
  | {
      type: 'approve';
      authorizations: AuthorizationEffect[];
      approvedReviewIds: string[];
      next: 'tools';
    }
  | {
      type: 'respond';
      messages: BaseMessage[];
      next: 'model';
    }
  | {
      type: 'reject';
      messages: BaseMessage[];
      next: 'pause_task';
    }
  | {
      type: 'cancel';
      messages: BaseMessage[];
      next: 'pause_task';
    };
```

The method owns this entire sequence:

1. Parse and validate the resume command against the complete atomic Review
   batch.
2. Apply only the authorization effects allowed by the accepted decision.
3. Construct protocol-complete message updates.
4. Select tools, model, or task pause as the next Runtime behavior.

| Resume result | Message/effect owned by `ReviewInterrupt` | Next behavior |
| --- | --- | --- |
| Approve | authorization effects for the accepted batch | tools |
| Respond | protocol-complete synthetic tool results | model |
| Reject | terminal rejected/cancelled results for every tool call | task pause |
| Cancel | removal of the unexecuted AI tool-call action | task pause |

Pure helpers in `review/` may implement individual validation, authorization,
and message operations. No caller outside `ReviewInterrupt` may reconstruct the
four-way policy by inspecting raw decisions, booleans, message shapes, or
`jumpTo` values.

Because `interrupt()` is called by the `afterModel` middleware node, resume
replays that middleware node. It does not replay the already committed model
node. The `interrupt()` call returns the accepted Review command on that replay,
after which `ReviewInterrupt.resume()` resolves its semantic outcome and
`ReviewInterrupt.materialize()` consumes `resolution.next` to produce the
complete LangChain state transition. The middleware records returned
authorization effects, merges approved Review IDs, and applies that transition
without branching on Approve, Respond, Reject, or Cancel.

### PauseTaskInterrupt

`PauseTaskInterrupt` represents stopped but unfinished work. Normal running Esc
is its primary source.

Its interaction contains no Review data. Its command is simply to continue,
optionally with user guidance:

```ts
type PauseTaskInterruptPayload = {
  kind: 'pause_task';
};

type PauseTaskInterruptCommand = {
  action: 'continue';
  guidance?: string;
};
```

`PauseTaskInterrupt` decides how continuation re-enters the Runtime from the
durable state that remains:

- after cancellation inside an unfinished LangGraph node, continue from the
  last committed graph boundary using the graph's normal continuation path;
- after Review resolution stopped the root run, re-enter the retained active
  delegation as a new Runtime invocation;
- when guidance is present, Pet Runtime constructs the corresponding
  `HumanMessage`; interfaces do not send LangChain message instances.

`PauseTaskInterrupt` therefore remains a required Runtime concept even though
it is not always backed by a pending dynamic `interrupt()`. It normalizes the
interaction and continuation contract for unfinished work. It must not create
a second state machine or duplicate resumability in a boolean.

#### Pause materialization boundary

`PauseTaskInterrupt` is the only owner of how a semantic task pause is realized
in LangGraph. Callers ask it to enter or continue a pause; they do not select a
mechanism themselves:

```text
semantic pause request
  -> PauseTaskInterrupt
       -> dynamic interrupt and later resume
       OR
       -> commit + END/unwind and later re-entry
```

The initial implementation uses commit plus END/unwind for a Review-origin
pause because the message transition must commit before the nested invocation
returns. That is an implementation policy, not part of the Review contract.
`PauseTaskInterrupt.enter()` owns the current `jumpTo: 'end'` choice.

Consequently:

- Review middleware may produce `next: 'pause_task'`, but must not directly call
  a second `interrupt()` or choose `END` for that pause;
- `createSubagent` and capability may invoke stable propagation adapters owned
  by `PauseTaskInterrupt`, but must not inspect how the pause was materialized;
- the Host sends semantic pause and continue commands through the Pet Runtime
  API; it must not choose between LangGraph resume and a new invocation;
- no public event or Agent Session field exposes the selected mechanism.

The nested graph requires producer and parent-boundary adapter call sites, so
the implementation cannot literally have only one call site. A later second
dynamic interrupt may require a dedicated graph boundary so the message update
commits first. That change may add PauseTaskInterrupt wiring, but must not alter
Review resolution, capability business rules, Agent Session, or an interaction
interface.

Whether a task is paused is derived from durable Runtime and graph state, for
example pending graph work or a retained active delegation. A finished task
must not project `PauseTaskInterrupt`.

## Replay-safe Review policy

Review policy may call a model or custom resolver before Pet Runtime knows
whether human Review is required. That work must not execute again when Review
resumes.

LangGraph's intended mechanism is a checkpointed `task()`. The enclosing node
replays from the start, while a completed task returns its recorded value. The
Review policy and `ReviewInterrupt` can therefore remain in one middleware:

```text
model
  -> ToolkitReviewMiddleware.afterModel
       -> prepare Review request
       -> resolve global Review policy in task()
       -> ReviewInterrupt when human input is required
```

LangGraph.js currently re-executes a completed `task()` when an interrupted
nested subgraph resumes. The recorded task return exists, but nested replay does
not apply it. This is upstream issue
[`langgraphjs#2667`](https://github.com/langchain-ai/langgraphjs/issues/2667),
with a pending fix in
[`langgraphjs#2679`](https://github.com/langchain-ai/langgraphjs/pull/2679).

Until that fix is released, `hasPendingReviewInterruptResume()` detects whether
the exact next interrupt slot already has a resume value. On that replay, the
middleware reconstructs the deterministic Review request but skips the global
policy resolver and proceeds directly to `ReviewInterrupt`. Consequently,
`reviewPolicy.request()` must remain deterministic and free of non-idempotent
side effects.

The compatibility helper is the only code allowed to inspect
`__pregel_scratchpad`, `interruptCounter`, `resume`, or `nullResume`. It is
tracked for removal in issue #749. After upgrading to a LangGraph release with
the fix, replace the helper with `task()` inside the same middleware; do not add
a preparation middleware or persisted prepared-action state.

## Review semantics

One AI message may contain multiple tool calls. Review treats that proposed
action atomically:

- no reviewed call executes until every required response validates;
- one rejection prevents every call in the action from executing;
- Reject produces a terminal result for every tool-call ID;
- Esc removes the complete proposed AI action;
- authorization effects apply only after the complete batch validates.

### Approve

Approve authorizes the reviewed action. Once the atomic Review batch validates,
the original tools execute and the child loop continues.

```text
ReviewInterrupt
  -> approve
  -> execute reviewed tool calls
  -> append real ToolMessages
  -> continue child
```

### Respond

Respond supplies requested information instead of authorizing the proposed
action. The raw tools do not execute. Pet Runtime appends protocol-complete
synthetic tool results containing the response and returns to the same child
model.

Respond is not rejection and does not stop the run unless a future Review
option explicitly declares that behavior.

### Reject

Reject is a semantic decision: the actor saw the proposed action and declined
it. The message history preserves that decision:

- keep the AI message containing all proposed tool calls;
- execute none of the raw tools;
- append one terminal `ToolMessage` for every tool-call ID;
- mark the selected action as rejected, including its reason when available;
- mark the remaining calls as cancelled with the rejected atomic batch;
- stop the current run after the message update commits.

```text
AI(tool calls)
  -> ReviewInterrupt
  -> reject
  -> ToolMessage(rejected: reason)
  -> ToolMessage(cancelled with batch) ...
  -> PauseTaskInterrupt
```

The terminal tool results are the rejection guidance. No separate
`rejectionGuidance` state is required. On a later continue, the same child sees
what it proposed and why it was rejected.

Reject must not call the model, Run Supervisor, capability finalization, delegation
announce, or handoff merely to stop the current run.

### Review Esc or cancellation

Review Esc closes the Review without deciding that the proposed action was
wrong:

- execute none of the raw tools;
- remove the complete, unexecuted AI tool-call message;
- append no rejection `ToolMessage`;
- restore the child lane to the committed boundary before the proposal;
- stop the current run after the removal commits.

```text
AI(tool calls)
  -> ReviewInterrupt
  -> cancel
  -> RemoveMessage(AI tool-call action)
  -> PauseTaskInterrupt
```

Continuing without guidance may cause the model to propose the same action
again. That is expected because cancellation supplied no negative guidance.

### Invalid or stale response

An unknown option, invalid option input, mismatched Review ID, stale interrupt
ID, wrong namespace, or wrong session must not mutate graph state.

The Host rejects identity mismatches before resume. `ReviewInterrupt` rejects
invalid semantic input. If an error is recoverable, the Runtime may present the
same Review again with JSON-safe error details; it must not silently convert an
invalid response into Reject or Esc.

## Review resolution to task pause

Reject and Review Esc consume the pending `ReviewInterrupt`. They must commit
their different message changes and then request a task pause. They do not
decide how that pause is materialized.

Instead, `ReviewInterrupt.resume()` returns the four-way
`ReviewInterruptResolution` defined above. Approve and Respond select tools and
model respectively. Reject and Cancel remain different resolution types, but
both select `next: 'pause_task'` after constructing their different message
updates. `PauseTaskInterrupt` constructs and materializes its own payload.

The `afterModel` adapter passes the resolution and message update to
`PauseTaskInterrupt`. It does not reinterpret the Review command, merge Reject
and Cancel into a generic stop decision, or choose between a second interrupt
and END/unwind. `PauseTaskInterrupt` is Runtime control flow, not
completed-result metadata.

The current subagent is invoked as a function from the capability node and has
a different state shape from the root graph. Returning through that function
boundary is necessary so capability can reconcile child messages and Runtime
state. It is not a second lifecycle transition and must not be exposed as a
`child END -> root END` business flow.

For an END/unwind implementation, the capability-side adapter propagates the
same `PauseTaskInterrupt` after reconciliation. It retains the active
delegation and skips finalize, announce, handoff, and Run Supervisor. The delegated
task remains unfinished. A dynamic-interrupt implementation may stay suspended
inside the child instead; this difference is hidden by `PauseTaskInterrupt`.

No additional public stop-control concept or interrupted completion reason is
needed. Only serializable `PauseTaskInterruptPayload` data may cross a graph or
checkpoint boundary; Pet Runtime reconstructs its behavior object outside the
graph. Mechanism-specific transport remains internal to
`pauseTaskInterrupt.ts`.

This design does not replace `SubagentResult` with a completed/interrupted
union. Existing completion reasons for genuinely completed subagent runs are a
separate concern and remain unchanged in this work. Review and task pause must
not be represented by a new or existing `completionReason`; their propagation
is Runtime-private interrupt control flow between `createSubagent` and the
capability node.

## Running Esc

Esc while a model or tool is actively running is a request to pause the task.
The interaction layer sends a semantic pause command. The Host uses its
`AbortSignal` to cancel the active invocation and waits for that invocation to
settle.

For an ordinary streaming model call:

- streaming stops;
- the unfinished node does not commit a partial AI message;
- no Review decision or synthetic `ToolMessage` is invented;
- no subagent completion reason is recorded;
- Pet Runtime determines whether unfinished work remains from graph and
  Runtime state;
- unfinished work is exposed as `PauseTaskInterrupt`.

Cancellation is the mechanism that stops currently executing code.
`PauseTaskInterrupt` is the Runtime meaning of the resulting unfinished task.
Neither replaces the other.

The Host must not decide whether to resume the graph, manufacture another
interrupt, or start a new invocation to realize the pause. It also must not read
or edit checkpointer storage. After cancellation settles, it delegates pause
projection and later continuation to the Pet Runtime interrupt API.

If no unfinished graph work or active delegation remains, the invocation ended
instead of pausing; no `PauseTaskInterrupt` is exposed.

Cancellation cannot roll back an external side effect that a tool already
committed. Tool implementations must honor `AbortSignal` where possible and
retain their own idempotency guarantees.

## Layer ownership

### Interaction interfaces

TUI, Chat, App, Studio, and future interfaces own presentation and input. They
send semantic commands such as:

- pause the running task;
- continue a paused task, optionally with guidance;
- respond to or cancel the identified Review.

They do not construct LangGraph commands, choose graph nodes, edit message
history, or interpret authorization effects.

### Agent Session and Host

Agent Session carries interface-safe events and commands. It does not own the
Runtime lifecycle and does not persist Pet Runtime classes, LangGraph commands,
checkpoint data, or a derived `continuationAvailable` flag.

The Host owns:

- cancellation of the active invocation;
- serialization of invocations for the same task;
- correlation of session, interrupt ID, namespace, and request identity;
- projection of Runtime interrupts to supported interfaces;
- translation of accepted semantic commands into Runtime calls;
- rejection of stale or mismatched commands.

The Host does not decide Review business behavior or synthesize graph state.

### Pet Runtime

Pet Runtime owns:

- `AgentInterrupt`, `ReviewInterrupt`, and `PauseTaskInterrupt` behavior;
- Review decision validation and effects;
- message-history transitions;
- detection of stopped but unfinished work from existing durable state;
- continuation of the correct child or root execution;
- stop-current-run propagation through a nested subagent boundary.

Pet Runtime does not use subagent completion metadata to represent pause and
does not route through Run Supervisor merely to stop a run.

### LangGraph

LangGraph owns:

- dynamic Review interrupt persistence;
- interrupt IDs and namespaces;
- graph state, checkpoints, replay, and pending tasks;
- delivery of Review resume values;
- continuation from the last committed graph boundary.

Pet Runtime and Host use LangGraph APIs. Review and pause handling are
checkpointer-transparent.

## Compatibility with the current implementation

The first implementation is centered in `packages/pet-agent`. It does not
require a new Agent Session lifecycle field.

| Current implementation | Target design |
| --- | --- |
| `afterModel` calls `interrupt(reviewPayload)` | `afterModel` raises `ReviewInterrupt` |
| `resolveHumanToolkitReviews` and response helpers | `ReviewInterrupt` validation and resolution |
| `hasPendingReviewInterruptResume()` and Pregel scratchpad inspection | temporary #749 compatibility; later replace with `task()` in the same middleware |
| `{ action: 'interrupt_run' }` | migration alias for Review `{ action: 'cancel' }` |
| `resumeModel`, `rollbackAction`, `pauseTask` booleans | explicit four-way `ReviewInterruptResolution` |
| `toolkitReviewPausePending` | removed |
| `afterAgent` calls `interrupt(null)` | centralized `PauseTaskInterrupt` materialization |
| child `completionReason: 'interrupted'` | Runtime-private `PauseTaskInterruptPayload` control flow |
| capability detects interruption policy itself | capability delegates child-boundary handling to `PauseTaskInterrupt` |
| running Esc only aborts an invocation | cancellation followed by `PauseTaskInterrupt` projection when work remains |

`createSubagent` still owns child execution. The capability remains responsible
for reconciling committed child messages. It delegates pause propagation to
`PauseTaskInterrupt`; only the initial END/unwind implementation ends the root
run at that boundary.

## Implementation sequence

### Phase 1: Pet Runtime Review stop path

1. Create `orchestrator/interrupt/` and introduce the runtime-local interrupt
   behavior contract without changing Agent Session.
2. Add `ReviewInterrupt` and `PauseTaskInterrupt` in that directory; keep
   Review policy and message rules in `orchestrator/review/`.
3. Encapsulate Review payload parsing and resolution in `ReviewInterrupt`.
4. Keep one Review middleware and isolate the temporary Pregel resume guard
   tracked by #749; replace it with `task()` after the upstream fix is released.
5. Replace Review-result booleans with a discriminated transition.
6. Remove `reviewRunControl.ts`, `toolkitReviewPausePending`, and any deferred
   interrupt descriptor.
7. Remove `completionReason: 'interrupted'`; let `PauseTaskInterrupt` own its
   Runtime-private transport without redesigning `SubagentResult` or its
   genuine-completion reasons.
8. Make the capability boundary call the stable `PauseTaskInterrupt` adapter
   while retaining the unfinished active delegation and skipping Run Supervisor.

### Phase 2: PauseTaskInterrupt and running Esc

1. Connect running Esc to `PauseTaskInterrupt` as the behavior for stopped but
   unfinished work.
2. Route Esc through a semantic task-pause command and active
   invocation cancellation.
3. After settlement, derive pause availability from existing graph/Runtime
   state rather than a new boolean.
4. Implement continue for both an unfinished graph node and a retained active
   delegation.
5. Add optional guidance at the Runtime boundary.

### Phase 3: Host and interface projection

1. Project `review` and `pause_task` as different interactions.
2. Keep exact Review interrupt identity for Review resume.
3. Send task continue to `PauseTaskInterrupt` without fabricating a Review
   resume.
4. Generalize the existing pending-interaction projection only if a shared
   interface requires it; do not add a continuation boolean.
5. Remove migration aliases after all active interfaces use semantic commands.

## Required behavioral coverage

### Review and Runtime

- approve executes every approved tool exactly once;
- respond appends protocol-complete synthetic results and returns to the same
  child model;
- reject executes no tool and appends one terminal result per tool-call ID;
- Review Esc executes no tool and removes the complete AI tool-call action;
- Reject and Review Esc commit their message changes before the run stops;
- Review middleware and capability contain no direct decision between another
  dynamic interrupt and END/unwind;
- pause materialization and its mechanism-specific state are owned only by
  `pauseTaskInterrupt.ts`;
- global auto/custom Review policy resolution executes once across interrupt
  and resume;
- Review request reconstruction is deterministic while the #749 compatibility
  guard is active;
- private Pregel resume inspection is confined to the temporary #749 helper and
  is removed when the policy resolver moves into `task()`;
- each Review resume command is mapped exactly once by `ReviewInterrupt.resume()`
  to Approve, Respond, Reject, or Cancel;
- the middleware contains no independent branching on raw Review decisions and
  only adapts the returned resolution to LangGraph;
- no model, Run Supervisor, finalize, announce, or handoff runs merely to stop;
- the active delegation remains unfinished and can later continue;
- invalid Review responses leave the original interrupt unresolved;
- class instances never appear in graph state or payloads.

### Running Esc and task continue

- Esc during model streaming aborts the invocation and commits no partial AI
  message;
- Esc during a cancellable tool propagates `AbortSignal`;
- stopped unfinished work projects `PauseTaskInterrupt`;
- genuinely finished work does not project `PauseTaskInterrupt`;
- continue re-enters the correct pending graph node or retained delegation;
- optional guidance becomes a Runtime-created message exactly once;
- cancellation itself performs no model, Run Supervisor, or tool call;
- reconnect derives the available interaction from durable graph/Runtime
  state, not interface-local overlay state.

### Identity and protocol

- Review resume requires the exact interrupt ID and namespace;
- stale, wrong-session, wrong-kind, and duplicate commands do not mutate state;
- `review` and `pause_task` produce different interface affordances;
- no continuation boolean is persisted independently of graph/Runtime state;
- unsupported required Review capabilities fail closed.

## Non-goals

- A separate Review state machine.
- Persisting interrupt class instances or Runtime services.
- Reading or editing checkpoint storage directly.
- Making private Pregel scratchpad state part of the permanent Review design;
  the isolated #749 compatibility helper is temporary.
- A deferred Review-specific pause descriptor outside `PauseTaskInterrupt`.
- Choosing the pause materialization mechanism outside
  `pauseTaskInterrupt.ts`.
- Using subagent `completionReason` to represent Review or pause.
- Routing through Run Supervisor merely to stop or pause a child.
- Adding a `continuationAvailable` field that duplicates derived state.
- Letting interfaces send graph nodes, delegation transitions, LangGraph resume
  values, or Runtime-internal Review effects.
- Treating TUI overlay state as the durable Runtime state.
