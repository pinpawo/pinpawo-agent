# Capability message lanes

Status: working design implemented by the current refactor.

## Decision

`OrchestratorState.messages` is the only canonical message collection. A message
is either:

- a main-conversation message with no lane; or
- a private Capability message tagged with one delegation scope.

There is no separate Transcript entity, message manager, view model, or prompt
composition state.

```ts
type DelegationMessageScope = {
  lane: `capability:${string}`;
  runId: string;
  delegationId: string;
};
```

`runId` remains stable when an interrupted delegation resumes in a later root
run. It is ordinary scope identity, not the identity of another message model.

## Message flow

```text
canonical messages
  -> select main + active delegation private messages
  -> append one current briefing
  -> invoke the Capability model
  -> reconcile returned messages
  -> tag new private messages with the same delegation scope
  -> canonical messages
```

The current briefing is invocation input. It is never written to canonical
messages.

## Query API

The shared message package exposes one immutable, snapshot-scoped query:

```ts
const query = queryAgentMessages(messages);

const main = query
  .main()
  .select();

const privateMessages = query
  .delegation(scope)
  .select();

const capabilityHistory = query
  .main()
  .delegation(scope)
  .select();
```

The query starts with nothing selected. Each method returns a new query, and
`select()` preserves canonical chronology.

The query knows only message ownership:

- `main()` selects untagged main messages;
- `delegation(scope)` selects private messages for one complete scope;
- `select()` returns messages and identity-only diagnostics.

It does not know about Planner inputs, Announce, prompts, artifacts, provider
roles, task completion, or visibility modes.

## Capability delegation protocol

The delegation package owns communication between the Orchestrator and a
Capability executor:

```text
Orchestrator
  -> HumanMessage(Delegation Briefing)
  -> Capability executor
  -> private result messages + typed Announce
  -> Planner Boundary
  -> continue the delegation or accept it through Handoff
```

It owns:

- building the current briefing;
- reconciling and tagging returned private messages;
- identifying typed Announces;
- accepting Announces into main through Handoff;
- clearing accepted private messages.

Toolkit instructions and artifact-discovery availability belong in Capability
prompt sections and bound tools, not synthetic history messages.

### Capability model input

```text
SystemMessage(Capability, Toolkit, runtime instructions)
Main messages + active delegation private messages
HumanMessage(current Delegation Briefing)
```

### Capability result

The runtime reconciles returned messages against the selected canonical input.
Only new executor output is tagged and written back. The runtime-supplied result
message identity determines Announce; text is never parsed to infer it.

## Planner protocol

Planner is a separate subagent protocol. It has no root message lane.

```text
OrchestratorState
  -> CapabilityPlannerInput
  -> Planner provider messages
  -> PlannerCommit
  -> OrchestratorState update
```

### Entry input

```text
SystemMessage(Entry objective)
Clean main conversation
HumanMessage(typed Entry input)
```

### Boundary input

The Orchestrator selects the active delegation's private messages, extracts its
ordered typed Announces, and constructs current typed input:

```text
CapabilityPlannerInput
  mode: boundary
  messages: clean main conversation
  activeDelegation: typed state
  announceAttempts: ordered executor evidence
  latestAnnounce: newest attempt or null
  remainingPlan: Planner session state
```

The provider receives:

```text
SystemMessage(Boundary objective)
Clean main conversation
HumanMessage(typed Boundary input)
```

Raw private Human, AI, and Tool messages do not enter Planner provider history.
Planner model/tool messages remain inside the run-scoped Planner session and do
not enter root `messages`.

## Announce and Handoff

`DelegationAnnounceMessage` is typed executor output. Its canonical payload and
provider projection belong to the delegation protocol, not lane selection.

Handoff accepts the typed Announce into main and removes all private messages in
the same delegation scope. Model consumers receive a provider-safe projection;
that projection never mutates canonical state.

## Other model nodes

Entry Answer and Answer select clean main messages. They do not inspect private
Capability messages or Planner provider messages.

Every model node owns its own typed-state-to-provider projection. The lane query
does not construct model calls.

## Package boundaries

```text
agent/messages/
  metadata.ts        lane and delegation-scope metadata
  query.ts           immutable canonical message query
  protocol.ts        provider tool-call sequence sanitation
  reconciliation.ts private-message reconciliation primitive

agent/orchestrator/delegation/
  briefing.ts        Orchestrator -> Capability current request
  privateMessages.ts returned-message tagging and reconciliation
  announceMessage.ts typed Capability -> Orchestrator result
  announce.ts        Announce selection and metadata
  handoff.ts         acceptance into main and private-message cleanup

agent/orchestrator/capabilityPlanner/
  input.ts           OrchestratorState -> CapabilityPlannerInput
  providerMessages.ts typed Planner input -> provider messages
  protocol.ts        terminal commit contract
  session.ts         run-scoped Planner state
  runner.ts          Planner execution boundary
```

## Rejected concepts

The design intentionally has no generic:

- `AgentMessageManager` or message view;
- source partitions or audience field;
- overlay abstraction;
- projector callback;
- `visibility: 'announces_only'` mode;
- caller-selectable lane protocol mode;
- invocation-only persistence metadata;
- Transcript entity separate from delegation private messages.

Selection diagnostics contain only location and message identities. They are
observability data, not another message model.

## Invariants

1. Root `messages` is the only canonical message collection.
2. Private Capability messages always have a complete delegation scope.
3. A fresh delegation never inherits another delegation's private messages.
4. Continuing a delegation reuses the same scope and private messages.
5. Briefing, Toolkit context, and Planner provider messages never enter root
   `messages`.
6. Planner Boundary receives typed Announce evidence, not raw private messages.
7. Handoff accepts typed Announces and clears the matching private messages.
8. Each model node owns its provider-input construction.

## Validation

- query tests cover chronology, immutability, exact scope, and diagnostics;
- Capability tests cover fresh-task isolation and same-delegation continuation;
- Planner tests cover Entry and Boundary input shapes;
- Boundary tests prove ordered Announce evidence without raw private messages;
- full typecheck, unit tests, context audit, and targeted real-model evals pass.

## Non-goals

This refactor does not change Planner decision policy, search budgets, terminal
actions, Announce semantics, user-facing answer policy, or artifact state.
