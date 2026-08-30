# Capability lane selection and model invocation boundaries

Status: working design implemented by the current refactor.

## Decision

Root `OrchestratorState` is the single source of truth for conversation,
planning, and execution lifecycle data. Message lanes do not form another state
model and do not own model-prompt composition.

A Capability lane has one narrow lifecycle:

```text
canonical messages
  -> reselect main + active delegation transcript
  -> invoke the Capability model
  -> reconcile the model result
  -> tag new messages with the active delegation scope
  -> canonical messages
```

Every model node separately projects typed state into the exact system, history,
and current-input messages required by that model. That projection is owned by
the node or subagent protocol, not by the lane package.

## Why the current abstraction is too broad

The current draft combines two independent operations:

1. select canonical messages by lane and delegation scope;
2. construct a provider invocation from prompts, runtime data, and temporary
   messages.

This produced a generic message manager with source ids, audiences, overlays,
projection hooks, visibility modes, provider-protocol options, named source
partitions, and a composition manifest. Most of those concepts do not describe
lane state. They describe one consumer's model invocation.

The result duplicates information already present in typed state and makes a
simple transcript boundary responsible for Planner input, delegation briefing,
Announce rendering, and Toolkit context.

This design removes that generic composition layer.

## Authoritative state

The root graph already stores typed lifecycle facts:

```text
OrchestratorState
  messages
  runUserRequest
  taskActiveDelegation
  runNextDelegation
  runPlannerSession
  runDelegationSummaries
  runLatestDelegationOutcome
  ...
```

No `AgentMessageManager`, `AgentMessageViewSpec`, or generic `ModelInvocation`
value becomes a second representation of those facts.

A model does not consume `OrchestratorState` directly. Its owning node performs
one pure projection from typed state to provider messages, then applies the typed
result back to state through a reducer or `Command`.

```text
OrchestratorState
  -> node-owned model-message projection
  -> model
  -> node-owned result materialization
  -> OrchestratorState update
```

## Canonical message ownership

A canonical root message is exactly one of:

- **main conversation**: no Capability lane metadata;
- **delegation transcript**: tagged with one complete Capability delegation
  scope.

```ts
type DelegationMessageScope = {
  lane: `capability:${string}`;
  transcriptRunId: string;
  delegationId: string;
};
```

The scope tuple is indivisible. Selecting by Capability name or lane alone is
not a valid transcript operation.

Planner history, Planner search calls, Planner terminal tools, delegation
briefings, and Toolkit invocation context are not canonical lane state.

## Lane query API

The shared message package exposes an immutable, snapshot-scoped query chain.
The chain starts with no selected source and adds only canonical ownership
clauses:

```ts
const query = queryAgentMessages(messages);

const main = query
  .main()
  .select();

const delegation = query
  .delegation(scope)
  .select();

const capabilityHistory = query
  .main()
  .delegation(scope)
  .select();
```

Each chain operation returns a new query value. `select()` evaluates the query
once against the bound canonical snapshot and preserves original message
chronology. Reusing the base query cannot leak clauses between node
invocations.

The query vocabulary is deliberately small:

- `main()` includes canonical main-conversation messages;
- `delegation(scope)` includes one explicitly named private delegation scope;
- `select()` returns the selected messages and small identity-only diagnostics.

The query has no arbitrary provider or prompt operations. Domain filtering such
as identifying Announces happens after scoped selection inside the executor
delegation protocol. The query knows nothing about Announce, Planner Boundary,
prompts, provider roles, artifacts, or task completion.

Provider tool-call sanitation remains a shared message utility, but it is
applied after a node has assembled its complete provider input. It is not a
caller-selectable lane visibility policy.

## Capability executor protocol

Delegation briefing, transcript reconciliation, Announce, and handoff form one
protocol between the root Orchestrator and a Capability executor subagent.

```text
Orchestrator
  -> Delegation Briefing
  -> Capability executor
  -> lane-scoped result messages + Announce
  -> Orchestrator Boundary
  -> continue the same delegation or accept through handoff
```

The protocol owns:

- the typed delegation briefing request;
- tagging and reconciling executor result messages;
- identifying the executor's typed Announce;
- continuing the same delegation transcript;
- accepting Announce values into main through handoff;
- clearing an accepted private transcript.

The lane package supplies only scoped selection and reconciliation primitives.

### Capability model input

The Capability node derives the active scope from typed state, reselects the
canonical history, and appends one current delegation briefing:

```text
SystemMessage(Capability, Toolkit, and runtime instructions)
Main + active delegation history
HumanMessage(Delegation Briefing)
```

The briefing is the Orchestrator's current request to the executor. It is a
Human-role invocation input, not an AI response and not a checkpoint message.

Toolkit-owned instructions, including artifact-discovery availability, belong
in the Capability system/prompt sections. They are not synthetic lane messages.

### Capability result

After the model returns, the Capability node reconciles the child transcript
against the selected canonical input, tags new messages with the active scope,
and marks the result message identified by the subagent runtime as Announce.

The node does not infer Announce identity or completion from text.

## Planner protocol

The Capability Planner is a separate subagent protocol. It does not own a root
message lane and does not consume a generic message view.

The Orchestrator sends typed `CapabilityPlannerInput`; the Planner returns one
typed terminal commit.

```text
OrchestratorState
  -> CapabilityPlannerInput
  -> Planner provider messages
  -> PlannerCommit
  -> root state transition
```

### Entry

Planner Entry receives:

```text
SystemMessage(Planner Entry objective)
Clean main conversation
HumanMessage(Planner Entry input)
```

The Entry input contains the normalized run goal and run-scoped Planner data.
It has no active delegation or execution evidence.

### Boundary

The root node uses the active delegation from typed state to select its private
transcript. The executor protocol extracts the ordered typed Announces from that
transcript. The Planner adapter then constructs `CapabilityPlannerInput`:

```text
conversation: clean main conversation
activeDelegation: typed root state
announceAttempts: typed executor evidence
latestAnnounce: the latest typed attempt or null
remainingPlan: typed Planner session state
```

The Planner provider input is:

```text
SystemMessage(Planner Boundary objective)
Clean main conversation
HumanMessage(Planner Boundary input)
```

Private raw executor Human, AI, and Tool messages are not part of Planner
history. Ordered Announces are current Boundary input data, not a lane visibility
mode and not a temporary mutation of canonical messages.

Planner provider messages, search calls, and terminal tool calls remain inside
the run-scoped Planner session. They never enter root `messages`.

## Other root model nodes

### Entry Answer

Entry Answer receives its system objective followed by clean main conversation.
The latest real user `HumanMessage` is already present in that conversation; the
node does not append a synthetic user message.

Its ordinary AI result is appended to main. A `plan_request` control result is
materialized as typed Planner dispatch state rather than persisted control
messages.

### Answer

Answer receives clean main conversation plus typed terminal outcome data owned
by the Answer node. It does not inspect private Capability transcripts or reuse
the Planner provider transcript.

Its user-facing AI result is appended to main.

## Typed domain messages and provider roles

`DelegationAnnounceMessage` is the typed executor-output message. Its canonical
payload and provider representation are owned by the executor delegation
protocol, not by lane selection.

When a model consumer needs explicit Announce provenance, that consumer uses the
Announce protocol's provider adapter. The adapter does not mutate canonical
state and is not a generic projection hook.

Provider-role discipline is:

- System: stable identity, objective, Capability/Toolkit instructions, and
  trusted runtime constraints;
- Human: the current caller request to this model or subagent;
- AI: prior model or executor output, including accepted typed Announces;
- Tool: a real result paired with a preceding tool call.

Run-specific tasks, active delegation data, Announce attempts, and remaining
plan belong in typed current input, not in a dynamically expanding system
prompt.

## Rejected concepts

The target design has no generic:

- message manager or prompt-composition DSL;
- source ids or named source partitions;
- audience field;
- overlay abstraction;
- projector callback;
- `visibility: 'announces_only'` mode;
- caller-selectable tool-protocol mode;
- invocation-only persistence metadata;
- composition manifest that models prompt construction as lane state.

If runtime observability is retained, each node emits a small diagnostic after
selection: location, active scope when applicable, selected message identities,
and excluded message identities. It includes no message body and does not become
another message-domain model.

## Target package boundaries

```text
agent/messages/
  metadata.ts        Capability lane and delegation scope metadata
  query.ts           snapshot-scoped canonical query chain
  protocol.ts        provider tool-call sequence sanitation
  reconciliation.ts child transcript reconciliation

agent/orchestrator/delegation/
  briefing.ts        Orchestrator -> Capability request
  announceMessage.ts typed Capability -> Orchestrator result
  announce.ts        Announce selection and metadata
  transcript.ts      result tagging and continuation
  handoff.ts         acceptance into main and lane cleanup

agent/orchestrator/capabilityPlanner/
  input.ts           OrchestratorState -> CapabilityPlannerInput
  providerMessages.ts typed Planner input -> provider messages
  protocol.ts        terminal commit contract
  session.ts         run-scoped Planner state
  runner.ts          Planner execution boundary
```

There is no generic `orchestrator/invocationMessages.ts`. Each subagent protocol
owns its own input and output representation.

## Invariants

1. `OrchestratorState` remains the only root lifecycle source of truth.
2. A Capability transcript is selected by the complete delegation scope.
3. A fresh delegation never inherits another delegation's private transcript,
   even when both use the same Capability.
4. Continuing a delegation reuses the same scope and transcript.
5. Only Capability executor results are tagged into Capability lanes.
6. Planner provider messages never enter root `messages`.
7. Briefing and Toolkit invocation context never enter canonical state.
8. Announce identity is supplied by the subagent runtime, never inferred from
   text or chronology alone.
9. Handoff accepts typed Announces and clears the matching private transcript.
10. Every node owns one explicit typed-state-to-model projection and one typed
    result materialization path.

## Implemented migration

1. Added behavior tests for the exact model input shape of Entry Answer, Planner
   Entry, Planner Boundary, Capability initial/continue, and Answer.
2. Deleted `manager.ts` and reduced `query.ts` to the bounded canonical query
   chain described above.
3. Split `delegationMessages.ts` along briefing, Announce, transcript, and
   handoff ownership.
4. Moved Planner Entry/Boundary input construction into the Planner protocol.
5. Made delegation briefing a current Human-role executor request.
6. Moved artifact-discovery model guidance into Toolkit/system prompt sections.
7. Deleted overlays, projection hooks, named source partitions, and the generic
   view manifest.
8. Updated affected raw design/reference documents; wiki ingest remains separate.

## Validation

The implementation is complete only when:

- typecheck and the full `pet-agent` unit suite pass;
- exact input-shape tests prove private-lane isolation and current-input roles;
- continuation tests prove same-delegation transcript reuse;
- sequential-task tests prove different-delegation isolation;
- Planner Boundary tests prove ordered Announce evidence without raw transcript;
- no invocation-only briefing or Toolkit context reaches root state;
- targeted real-model Entry and Boundary evals show no stable regression.

## Non-goals

This refactor does not change Planner decision policy, search budgets, terminal
actions, Announce payload semantics, user-visible answer policy, or artifact
state. It changes ownership and message placement so those behaviors no longer
depend on a generic lane-composition framework.
