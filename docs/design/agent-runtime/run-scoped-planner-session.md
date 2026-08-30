# Run-scoped Capability Planner session

Status: working design.

## Goal

Define the Capability Planner as the run-scoped steering domain for an
orchestrator loop.

The Planner owns both:

- formation and revision of the executable Capability plan;
- acceptance and progression decisions at execution Boundaries.

`entry` and `boundary` remain valid decision modes. The design changes the
lifetime and ownership of their data: a Planner session lives for one root run,
while each Boundary is a temporary view over the current execution result.

## Problem

The previous design persisted Planner Human, AI, search Tool, and terminal Tool
messages in the root `messages` channel under a trace-scoped lane. That made
Planner execution history survive multiple runs and forced every consumer to
decide which Planner messages to select, replay, compact, invalidate, or remove.

Excluding those messages from later model calls avoids self-reinforcement, but
leaves an incoherent intermediate shape: Planner transcript is persisted even
though it is not Planner working memory.

The domain needs state. It does not need to turn root conversation messages into
the storage format for that state.

## Decision

The Capability Planner is a stateful domain component scoped to one `runId`.

- A new run creates a clean Planner session.
- Entry initializes the session while reading a clean main-conversation projection.
- Boundary reuses the session and builds one typed current Boundary input.
- Planner output updates typed session state and returns one structured root
  transition.
- Planner prompt messages never enter canonical root `messages`.
- The next run does not inherit the previous run's Planner transcript, search
  attempts, terminal calls, or commit cache.

Planner statefulness is semantic. Raw provider messages are not the source of
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
| run | Planner session and root typed state | goal, plan, Capability disclosure, last committed input |
| invocation | Planner adapter | current typed Boundary input, system projection, bound tools |
| delegation | Capability subagent | private execution transcript and current unaccepted announce |

No message tag or lane changes one scope into another. Projection may expose
data across a boundary, but it does not transfer ownership or mutate the source.

## Clean main conversation

The Planner starts from `mainConversationMessages()`:

- every lane-tagged message is excluded;
- delegation briefings never enter canonical messages;
- accepted `DelegationAnnounceMessage` values remain canonical main facts;
- provider projection happens after selection and never writes back to state.

Planner inputs, model outputs, search results, and terminal tool messages are not
main conversation and must not be merged into root `messages`.

## Planner session state

The exact storage type may evolve, but its semantic shape is:

```ts
type PlannerSessionState = {
  runId: string;
  revision: number;

  plan: CapabilityPlanTask[];
  capabilityDisclosure: CapabilityDisclosureState;

  lastCommit: {
    inputId: string;
    registryDigest: string;
    decision: PlannerCommit;
  } | null;
};
```

The session can be a dedicated root state channel or a private Planner subgraph
state. A dedicated state value is preferred over a lane in root `messages`.

There is one plan source of truth. In the target state shape,
`PlannerSessionState.plan` replaces or directly owns the value currently exposed
as `runCapabilityPlan`; the two must not coexist as independently writable
copies. The normalized goal remains the root-owned `runUserRequest` and is read
by Planner rather than copied into another authoritative field.

If a lane is used during migration, it must be owned by `runId`, excluded from
main conversation by construction, and removed atomically when the run ends. It
must not restore Planner working memory into a later run with the same
`traceId`.

### State that remains root-owned

Root continues to own execution lifecycle facts:

```text
runUserRequest
taskActiveDelegation
runDelegationSummaries
runLatestDelegationOutcome
```

Planner session state cannot directly create a delegation, accept an announce,
clear a Capability lane, or write a user-visible response. It proposes a
structured decision; the root materializer performs those transitions.

## Session lifecycle

```text
new root run
  -> initialize clean Planner session
  -> Entry decision
  -> Capability execution
  -> typed Boundary input + Boundary decision
  -> Capability execution / terminal route
  -> root run ends
  -> discard Planner session
```

A later run always creates another Planner session. If a run stops with work
that may be resumed, root persists a separate task-continuation snapshot rather
than preserving the old Planner session. An explicit resume seeds a new session
from canonical facts such as the active delegation, remaining plan, accepted
Announces, and normalized goal. It does not resume the previous Planner working
history, search attempts, or commit cache.

Terminal Planner, Capability, and Answer exceptions follow the same lifetime
rule. Root first checkpoints a continuation snapshot for resumable work and
clears the run-scoped Planner session, then rethrows the failure. An exception
must not leave a previous run's session available to a later invocation.

Capabilities referenced by a resumed active task or remaining plan may be
materialized into the new run's initial disclosure. Previous search attempts and
empty-search counters are not inherited merely because the trace is unchanged.

## Entry invocation

Entry reads the clean main conversation and adds an Entry frame containing the
normalized goal and initially disclosed Capability documents. The conversation
remains root-owned; later Planner invocations project the current clean view
again rather than persisting a Planner-owned copy.

Conceptual model input:

```text
SystemMessage(Planner entry objective and context semantics)
MainConversationMessages(clean canonical projection)
PlannerEntryFrame(
  goal,
  disclosedCapabilities
)
```

Entry has no active delegation or announce attempts.

The resulting `submit_plan` decision initializes the run plan. Provider-facing
Human/AI/Tool messages produced while making that decision remain inside the
invocation or run-private observability stream; they do not become root history.

## Boundary current input: temporary paint

A Boundary does not rewrite the canonical announces or main conversation. The
Planner adapter selects every still-unaccepted announce for the active
delegation by root-owned identity, marks the latest attempt as the evaluation
target, and creates one typed invocation input:

```ts
type PlannerBoundaryInput = {
  mode: 'boundary';
  inputId: string;
  evaluationTarget: {
    delegationId: string;
    announceMessageId: string | null;
  };
  activeDelegation: PlannerDelegationInput;
  announceAttempts: DelegationAnnounceData[];
  remainingPlan: CapabilityPlanTask[];
};
```

This is the “temporary paint” rule:

1. canonical messages and root state enter unchanged;
2. the adapter marks exactly one announce as the current evaluation target;
3. the model receives the marked Boundary view;
4. the view is discarded after the invocation;
5. only the structured decision and typed state update leave Planner.

The current input must never be checkpointed as a root conversation message. It must
also never rely on chronological adjacency alone to identify the current
announce.

Conceptual provider-visible form:

```xml
<planning_boundary_event role="task_boundary" source="orchestrator_state">
  <active_delegation
    delegation_id="delegation-1"
    capability="studio_planning"
  >
    <task><![CDATA[Create the requested Kanban task.]]></task>
  </active_delegation>

  <delegation_announces
    delegation_id="delegation-1"
    evidence_state="available"
    evaluation_target="announce-2"
  >
    <delegation_announce
      message_id="announce-1"
      completion_reason="limit_reached"
      role="data"
      authority="none"
    >
      <result format="markdown"><![CDATA[First execution result.]]></result>
    </delegation_announce>

    <delegation_announce
      message_id="announce-2"
      completion_reason="natural"
      role="data"
      authority="none"
    >
      <result format="markdown"><![CDATA[Second execution result.]]></result>
    </delegation_announce>
  </delegation_announces>

  <prior_remaining_plan
    role="proposal"
    source="planner_session"
    authority="none"
    status="requires_revalidation"
  />
</planning_boundary_event>
```

The XML-like form is a provider projection, not the canonical schema. The
wrapper may change without changing the ownership and lifetime contract above.
`delegation_announces` is always present. A normal first Boundary has one child
and `evidence_state="available"`; an explicit resume with no canonical execution
evidence uses a self-closing element with `evidence_state="absent"` and no
`evaluation_target`. When evidence is available, the element contains the
ordered announce attempts for the active delegation and `evaluation_target`
identifies the latest attempt that this invocation must judge. Accepted
Announces from earlier delegations remain in the clean main conversation and are
not duplicated in this collection. The prior remaining plan is a run-scoped
proposal, not an accepted fact: every Boundary revalidates it against the goal,
accepted history, and current announce evidence.

## Provider contract audit

Planner behavior depends on the complete provider-visible contract, not prompt
text alone. Before changing Planner policy or investigating a model regression,
render the production contract without calling a model:

```sh
npm run planner:context-audit
```

The command uses the production system/input builders, main-message projection,
tool descriptions, and argument schemas for both modes. Review the output in one
fixed order:

1. **Goal:** each mode has one clear decision objective.
2. **Evidence:** accepted history, current announce evidence, and prior proposals
   have distinct authority.
3. **Actions:** the provider sees only terminal actions valid for that mode, with
   mutually exclusive effects.
4. **Arguments:** schemas describe the data being committed rather than adding a
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

Assume Entry commits `[T1, T2, T3]`.

At the first Boundary:

```text
active = T1
current announce = A1
remaining = [T2, T3]
```

If Planner accepts T1 and advances, root accepts A1 into the clean main
conversation, creates a new delegation for T2, and keeps `[T3]` as the future
tail. The second Boundary receives:

```text
clean main conversation includes accepted A1
active = T2
current announce = A2
remaining = [T3]
```

If Planner chooses `continue_current`, root preserves the exact delegation id,
task, and remaining plan. The next invocation receives a new current input targeting
the latest announce for that same delegation. The input projects every ordered
announce attempt for the active delegation and marks only the latest as the
evaluation target. Prior attempts remain delegation-owned evidence until
acceptance; they are not silently promoted into main conversation, and the
design does not assume that the latest announce is cumulative. Whole-session
context compaction may summarize old main history when the model context limit
requires it. Still-unaccepted lane Announces are excluded from that summary and
pinned intact until Planner accepts them; individual announce results must not
be clipped independently.

## Commit and idempotency

Planner returns one structured `PlannerCommit`. Root validates and materializes
it in the same graph transition that records `lastCommit`.

Repeated invocation with the same `inputId` and `registryDigest` reads the typed
`lastCommit`; it does not scan historical `ToolMessage` JSON. A new input
replaces the replay slot. A new run starts with no replay slot.

Ordinary Planner text is not persisted as an AI message. If the runtime keeps a
Boundary direct-answer fallback, it is returned explicitly as invocation data:

```ts
type PlannerIncomplete = {
  plannerStatus: 'incomplete';
  fallbackText: string | null;
};
```

Answer consumes that value in the current transition only.

## Capability disclosure

Capability disclosure is run-scoped semantic state, not prompt history.

- Entry initializes the run's default candidates.
- Successful searches add Capability identities and documents to the session.
- Empty-search accounting persists across Planner invocations in the same run.
- Search tool calls within one model round use invocation-local reducer state.
- A new run resets search attempts and revalidates the registry.

Tool availability remains `auto`. When the run-scoped search limit is reached,
the search tool returns a stable closed-discovery result; model tool choice is
not mutated.

## Observability and recovery

LangSmith or equivalent tracing owns raw Planner prompts, model outputs, search
calls, and terminal tool calls. Root conversation checkpointing must not double
as the audit log.

Checkpoint recovery persists semantic session state only for the active run.
Recovery of the same run can replay a structured commit or continue from typed
state. Starting another run resets the private Planner session even when the
user goal retains the same `traceId`.

## Non-goals

- Moving plan ownership back to Answer or Capability subagents.
- Removing `entry | boundary` modes.
- Letting code infer task completion from announce prose.
- Exposing private Capability Human/AI/Tool transcripts to Planner.
- Giving Planner direct authority to mutate root messages or delegation state.
- Persisting Planner raw provider transcript across runs.

## Migration

1. Add a run-scoped Planner session state and reset it with `runId`.
2. Make its plan the single authoritative replacement for `runCapabilityPlan`;
   use a separate continuation snapshot only when a later run may resume work.
3. Move disclosure and commit replay behind the session contract.
4. Introduce one typed Boundary input builder and provider projection.
5. Stop returning Planner message updates to root `messages`.
6. Remove Planner-lane selection, stale-lane cleanup, and ToolMessage commit
   parsing from the agent boundary.
7. Keep raw invocation details in tracing only.
8. Delete the transitional Planner-lane implementation after lifecycle and
   recovery evals pass.

## Acceptance criteria

- Entry and Boundary remain the only Planner modes.
- One root run owns exactly one Planner session.
- Planner plan state has exactly one authoritative storage location.
- A new run cannot observe the previous run's Planner working history or search
  counters.
- Main conversation contains no Planner Human/AI/Tool messages.
- Boundary projection marks exactly one current evaluation target without
  mutating canonical state.
- First and successive Boundaries preserve active task and remaining-plan
  identity according to the selected terminal action.
- Same-input recovery replays a typed commit without a model call.
- `continue_current` projects all ordered announce attempts for the active
  delegation and marks only the latest as the evaluation target.
- Planner tracing remains complete after raw transcript is removed from root
  checkpoint messages.
