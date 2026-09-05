# Run-scoped Supervisor session

Status: working design.

## Goal

Define the Run Supervisor as the model-driven, run-scoped steering domain for
an orchestrator loop. Planning is one of its responsibilities, not its identity.

This document owns Supervisor session lifetime, semantic memory, context, and
replay. The [Delegation Boundary Protocol](delegation-boundary-protocol.md)
owns Capability exit, Announce eligibility, acceptance, and command
convergence. Those policies are not duplicated here.

The Supervisor owns:

- formation and revision of the executable Capability plan;
- acceptance and progression decisions at execution Boundaries;
- correction of the next execution attempt through the same plan and
  delegation commands, without introducing semantic routing flags.

The deterministic root Orchestrator remains the only component that mutates
canonical messages, delegation lifecycle, and graph state. The Supervisor
observes canonical facts and proposes commands; it is not another Orchestrator.

`entry` and `boundary` remain valid decision modes. The design changes the
lifetime and ownership of their data: a Supervisor session lives for one root run,
while each Boundary is a temporary view over the current execution result.

## Problem

The previous design persisted Supervisor Human, AI, search Tool, and command Tool
messages in the root `messages` channel under a trace-scoped lane. That made
Supervisor execution history survive multiple runs and forced every consumer to
decide which Supervisor messages to select, replay, compact, invalidate, or remove.

Excluding those messages from later model calls avoids self-reinforcement, but
leaves an incoherent intermediate shape: Supervisor provider messages are
persisted even though they are not Supervisor working memory.

The domain needs state. It does not need to turn root conversation messages into
the storage format for that state.

## Decision

The Run Supervisor is a stateful domain component scoped to one `runId`.

- A new run creates a clean Supervisor session.
- Entry initializes the session while reading a clean main-conversation projection.
- Boundary reuses the session and builds one typed current Boundary input.
- Supervisor delivers at most one control proposal per invocation; root
  validates and materializes its related effects in one transition.
- Supervisor prompt messages never enter canonical root `messages`.
- The next run does not inherit the previous run's Supervisor provider messages,
  search attempts, command calls, or command replay cache.

Supervisor statefulness is semantic. Raw provider messages are not the source of
truth for the plan, current task, disclosure state, or idempotency.

## Independent axes

Decision mode and data lifetime are independent.

### Decision mode

| Mode | Purpose |
|---|---|
| `entry` | Form the initial executable plan or choose a non-execution terminal outcome. |
| `boundary` | Evaluate the current delegation result and keep, continue, revise, or finish the plan. |

### Data lifetime

| Scope | Owner | Examples |
|---|---|---|
| conversation/goal | root | clean main conversation, accepted Delegation Announces |
| run | Supervisor session and root typed state | goal, plan, Capability disclosure, last command input |
| invocation | Supervisor adapter | current typed Boundary input, system projection, bound tools |
| delegation | Capability subagent | private execution messages and current unaccepted announce |

No message tag or lane changes one scope into another. Projection may expose
data across a boundary, but it does not transfer ownership or mutate the source.

## Clean main conversation

The Supervisor starts from the centralized `queryAgentMessages(...).main()` view:

- every lane-tagged message is excluded;
- delegation briefings never enter canonical messages;
- accepted `DelegationAnnounceMessage` values remain canonical main facts;
- provider projection happens after selection and never writes back to state.

Supervisor inputs, intermediate model outputs, search results, and control-tool
messages remain private. The final natural reply alone is projected to main by
the terminal node. Main may also contain handed-off evidence from replaced,
unsuccessful execution; presence in main does not establish task success.

## Supervisor session state

The exact storage type may evolve, but its semantic shape is:

```ts
type RunSupervisorSessionState = {
  runId: string;
  revision: number;

  plan: CapabilityPlanTask[];
  capabilityDisclosure: CapabilityDisclosureState;

};
```

The session can be a dedicated root state channel or a private Supervisor subgraph
state. A dedicated state value is preferred over a lane in root `messages`.

There is one plan source of truth. In the target state shape,
`RunSupervisorSessionState.plan` replaces or directly owns the value currently exposed
as `runCapabilityPlan`; the two must not coexist as independently writable
copies. The normalized goal remains the root-owned `runUserRequest` and is read
by Supervisor rather than copied into another authoritative field.

Tool-effect replay is runtime bookkeeping, not model-visible semantic session
state. Inspect the current `lastCommand` slot against existing graph checkpoint
and control-tool routing before deciding whether to retain it. No additional
per-tool replay ledger or Supervisor message lane is prescribed by this draft.

### State that remains root-owned

Root continues to own execution lifecycle facts:

```text
runUserRequest
taskActiveDelegation
runDelegationSummaries
runLatestDelegationOutcome
```

Supervisor session state cannot directly create a delegation, accept an announce,
clear a Capability lane, or write a user-visible response. It proposes a
structured command; the root materializer performs those transitions.

## Session lifecycle

```text
new root run
  -> initialize clean Supervisor session
  -> Entry decision
  -> Capability execution
  -> typed Boundary input + Boundary decision
  -> Capability execution / terminal route
  -> root run ends
  -> discard Supervisor session
```

A later run always creates another Supervisor session. If a run stops with work
that may be resumed, root persists a separate task-continuation snapshot rather
than preserving the old Supervisor session. An explicit resume seeds a new session
from canonical facts such as the active delegation, remaining plan, accepted
Announces, and normalized goal. It does not resume the previous Supervisor working
history, search attempts, or command replay cache.

Terminal Supervisor, Capability, and Answer exceptions follow the same lifetime
rule. Root first checkpoints a continuation snapshot for resumable work and
clears the run-scoped Supervisor session, then rethrows the failure. An exception
must not leave a previous run's session available to a later invocation.

Capabilities referenced by a resumed active task or remaining plan may be
materialized into the new run's initial disclosure. Previous search attempts and
empty-search counters are not inherited merely because the trace is unchanged.

## Entry invocation

Entry reads the clean main conversation and adds an Entry frame containing the
normalized goal, the compact Capability routing manifest, and any Capability
documents already disclosed by continuation state. The conversation
remains root-owned; later Supervisor invocations project the current clean view
again rather than persisting a Supervisor-owned copy.

Conceptual model input:

```text
SystemMessage(Supervisor entry objective and context semantics)
MainConversationMessages(clean canonical projection)
SupervisorEntryFrame(
  goal,
  routingManifest,
  disclosedCapabilities
)
```

Entry has no active delegation or announce attempts.

The resulting plan-commit command initializes the run plan. Provider-facing
Human/AI/Tool messages produced while making that decision remain inside the
invocation or run-private observability stream; they do not become root history.

## Boundary current input: temporary paint

A Boundary does not rewrite the canonical announces or main conversation. The
Supervisor adapter selects every still-unaccepted announce for the active
delegation by root-owned identity, marks the latest attempt as the evaluation
target, and creates one typed invocation input:

```ts
type SupervisorBoundaryInput = {
  mode: 'boundary';
  inputId: string;
  evaluationTarget: {
    delegationId: string;
    announceMessageId: string;
  };
  activeDelegation: SupervisorDelegationInput;
  announceAttempts: DelegationAnnounceData[];
  remainingPlan: CapabilityPlanTask[];
};
```

This is the “temporary paint” rule:

1. canonical messages and root state enter unchanged;
2. the adapter marks exactly one announce as the current evaluation target;
3. the model receives the marked Boundary view;
4. the view is discarded after the invocation;
5. one control proposal or a natural final reply leaves Supervisor.

The current input must never be checkpointed as a root conversation message. It must
also never rely on chronological adjacency alone to identify the current
announce.

Conceptual provider-visible form:

```xml
<supervision_boundary_event role="task_boundary" source="orchestrator_state">
  <active_delegation
    delegation_id="delegation-1"
    capability="studio_planning"
  >
    <task><![CDATA[Create the requested Kanban task.]]></task>
  </active_delegation>

  <delegation_announces
    delegation_id="delegation-1"
    evaluation_target="announce-2"
  >
    <delegation_announce
      message_id="announce-1"
      role="data"
      authority="none"
    >
      <result format="markdown"><![CDATA[First execution result.]]></result>
    </delegation_announce>

    <delegation_announce
      message_id="announce-2"
      role="data"
      authority="none"
    >
      <result format="markdown"><![CDATA[Second execution result.]]></result>
    </delegation_announce>
  </delegation_announces>

  <prior_remaining_plan
    role="proposal"
    source="supervisor_session"
    authority="none"
    status="requires_revalidation"
  />
</supervision_boundary_event>
```

The XML-like form is a provider projection, not the canonical schema. The
wrapper may change without changing the ownership and lifetime contract above.
`delegation_announces` is always non-empty. A normal first Boundary has one child.
Resume without new result evidence stays with the recovery path and does not
introduce an empty Boundary or a third Supervisor mode. The element contains the
ordered announce attempts for the active delegation and `evaluation_target`
identifies the latest attempt that this invocation must judge. Accepted
Announces from earlier delegations remain in the clean main conversation and are
not duplicated in this collection. The prior remaining plan is a run-scoped
proposal, not an accepted fact: every Boundary revalidates it against the goal,
accepted history, and current announce evidence.

## Provider contract audit

Supervisor behavior depends on the complete provider-visible contract, not prompt
text alone. Before changing Supervisor policy or investigating a model regression,
render the production contract without calling a model:

```sh
npm run supervisor:context-audit
```

The command uses the production system/input builders, main-message projection,
tool descriptions, and argument schemas for both modes. Review the output in one
fixed order:

1. **Goal:** each mode has one clear decision objective.
2. **Evidence:** accepted history, current announce evidence, and prior proposals
   have distinct authority.
3. **Actions:** the provider sees only command actions valid for that mode, with
   mutually exclusive effects and complete coverage of valid Boundary states.
4. **Arguments:** schemas describe the command payload rather than adding a
   second decision policy.
5. **Scope:** private executor-lane messages are absent, while accepted main
   conclusions remain visible.
6. **Runtime:** code validates typed identity and shape; it does not infer semantic
   completion from announce prose.

The system message owns decision policy. Tool descriptions state tool effect and
eligibility concisely; argument descriptions state serialized data semantics.
Static audit is a reasoning aid, not a prose snapshot test. Validate changes with
behavior tests and targeted model evals.

## Successive Boundaries

Assume Entry submits `[T1, T2, T3]`.

At the first Boundary:

```text
active = T1
current announce = A1
remaining = [T2, T3]
```

If Supervisor proposes acceptance and execution of `[T2, T3]` in one decision,
root hands A1 into main, creates the T2 delegation, and keeps `[T3]` as the future
tail in one transition. Acceptance with a reply instead dispatches nothing.
The second Boundary receives:

```text
clean main conversation includes accepted A1
active = T2
current announce = A2
remaining = [T3]
```

If Supervisor chooses `continue_current`, root preserves the exact delegation id,
task, and remaining plan. The next invocation receives a new current input targeting
the latest announce for that same delegation. The input projects every ordered
announce attempt for the active delegation and marks only the latest as the
evaluation target. Prior attempts remain delegation-owned evidence until
acceptance; they are not silently promoted into main conversation, and the
design does not assume that the latest announce is cumulative. Whole-session
context compaction may summarize old main history when the model context limit
requires it. Still-unaccepted lane Announces are excluded from that summary and
pinned intact until Supervisor accepts them; individual announce results must not
be clipped independently.

## Commands and idempotency

The Delegation Boundary Protocol owns the single-proposal interaction and
natural-text terminal interface. Exploration can involve multiple tool calls,
but a control proposal ends the invocation. Root validates the complete proposal
before applying its effects; multiple control calls cannot be executed in sequence.

The current last-command cache reuses a decision for the same input. It does not
alone guarantee exactly-once effects. Before changing it, inspect existing graph
checkpoint and control-tool routing. Keep replay identity and registry validation
runtime-owned; root main history is never a command log. The design does not yet
choose a new cache or effect ledger.

A natural final reply is passed to the terminal node without implying acceptance
or dispatch. A proposal that both accepts and replies must carry both effects in
one transition; its schema is still open. Intermediate provider messages remain
private. Migration removes the old missing-command terminal category only after
the natural-text interface and invalid-output error path are defined.

## Capability disclosure

Capability disclosure is run-scoped semantic state, not prompt history.

- Entry initializes the run's default candidates.
- Successful searches add Capability identities and documents to the session.
- Empty-search accounting persists across Supervisor invocations in the same run.
- Search tool calls within one model round use invocation-local reducer state.
- A new run resets search attempts and revalidates the registry.

Tool availability remains `auto`. When the run-scoped search limit is reached,
the search tool returns a stable closed-discovery result; model tool choice is
not mutated.

## Observability and recovery

LangSmith or equivalent tracing owns raw Supervisor prompts, model outputs, search
calls, and command tool calls. Root conversation checkpointing must not double
as the audit log.

Checkpoint recovery persists semantic session state only for the active run.
Recovery of the same run can replay a structured command or continue from typed
state. Starting another run resets the private Supervisor session even when the
user goal retains the same `traceId`.

## Non-goals

- Moving plan ownership back to Answer or Capability subagents.
- Redesigning Answer as the Run Finalizer in the same migration.
- Removing `entry | boundary` modes.
- Letting code infer task completion from announce prose.
- Treating Capability stop reasons as Supervisor input or acceptance policy.
- Exposing private Capability Human/AI/Tool messages to Supervisor.
- Giving Supervisor direct authority to mutate root messages or delegation state.
- Persisting Supervisor raw provider messages across runs.

## Migration

1. Add a run-scoped Supervisor session state and reset it with `runId`.
2. Make its plan the single authoritative replacement for `runCapabilityPlan`;
   use a separate continuation snapshot only when a later run may resume work.
3. Keep disclosure in the session and verify runtime replay for a single proposal.
4. Introduce one typed Boundary input builder and provider projection.
5. Stop returning Supervisor message updates to root `messages`.
6. Remove Supervisor-lane selection, stale-lane cleanup, and ToolMessage command
   parsing from the agent boundary.
7. Keep raw invocation details in tracing only.
8. Delete the transitional Supervisor-lane implementation after lifecycle and
   recovery evals pass.

## Acceptance criteria

- Entry and Boundary remain the only Supervisor modes.
- One root run owns exactly one Supervisor session.
- Supervisor plan state has exactly one authoritative storage location.
- A new run cannot observe the previous run's Supervisor working history or search
  counters.
- Main conversation contains no raw Supervisor transcript; only its final reply
  is projected through the terminal node.
- Boundary projection marks exactly one current evaluation target without
  mutating canonical state.
- First and successive Boundaries preserve active task and remaining-plan
  identity according to the selected command.
- Recovery of a committed proposal does not repeat acceptance or dispatch.
- `continue_current` projects all ordered announce attempts for the active
  delegation and marks only the latest as the evaluation target.
- Boundary Announces expose result evidence without Capability stop reasons.
- Supervisor tracing remains complete after raw provider messages are removed from root
  checkpoint messages.
