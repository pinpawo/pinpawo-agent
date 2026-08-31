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
  -> append one current briefing to agent state
  -> on every model request
     -> project typed domain messages
     -> repair provider tool-call ordering
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
  .append(delegationBriefing)
  .select();
```

The query starts with nothing selected. Each method returns a new query, and
`select()` preserves canonical chronology.

The query knows only message ownership:

- `main()` selects untagged main messages;
- `delegation(scope)` selects private messages for one complete scope;
- `append(messages)` adds invocation-only messages after canonical history;
- `select()` returns the ordered input and identity-only canonical diagnostics.

`append()` does not classify its input or persist it. The node constructs the
typed current message; the query only owns its position after selected history.
The query knows nothing about Supervisor meaning, Announce rendering, prompts,
artifacts, provider roles, or task completion.

## Model invocation

Nodes use the same query for canonical selection and invocation-local input:

```ts
const input = queryAgentMessages(messages)
  .main()
  .delegation(scope)
  .append(delegationBriefing)
  .select();

agent.invoke({ messages: input.messages });
```

Provider-specific work is private runtime wiring, not another message API. The
final Agent middleware renders typed Announces and repairs tool-call ordering on
each real model call. Entry Answer uses the same runtime boundary for its direct
model invocation. Nodes never call a separate prepare, project, or view helper.
System prompts remain independently owned by the caller or LangChain's
`ModelRequest.systemMessage` and never enter the lane query.

## Capability delegation protocol

The delegation package owns communication between the Orchestrator and a
Capability executor:

```text
Orchestrator
  -> HumanMessage(Delegation Briefing)
  -> Capability executor
  -> private result messages + typed Announce
  -> Supervisor Boundary
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
Only new executor output is written back. The runtime-supplied result message
identity determines which output is materialized as a lane-scoped
`DelegationAnnounceMessage`; text is never parsed to infer it. Ordinary private
messages and the typed Announce use the same complete delegation scope.

## Supervisor protocol

Supervisor is a separate subagent protocol. It has no root message lane.

```text
OrchestratorState
  -> RunSupervisorInput
  -> Supervisor provider messages
  -> SupervisorCommand
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
RunSupervisorInput
  mode: boundary
  messages: clean main conversation
  activeDelegation: typed state
  announceAttempts: ordered executor evidence
  latestAnnounce: newest attempt or null
  remainingPlan: Supervisor session state
```

The provider receives:

```text
SystemMessage(Boundary objective)
Clean main conversation
HumanMessage(typed Boundary input)
```

Raw private Human, AI, and Tool messages do not enter Supervisor provider history.
Supervisor model/tool messages remain invocation-private observability data and
do not enter either the typed Supervisor session or root `messages`.

## Announce and Handoff

`DelegationAnnounceMessage` is typed executor output. Its canonical payload and
provider projection belong to the delegation protocol, not lane selection.

Handoff accepts the typed Announce into main and removes all private messages in
the same delegation scope. Model consumers receive a provider-safe projection;
that projection never mutates canonical state.

## Other model nodes

Entry Answer selects clean main messages through the same query and invokes its
model through the shared runtime boundary.
Answer receives a closed fact-only input and intentionally receives no canonical
conversation history. Neither inspects private Capability messages or Supervisor
provider messages.

The lane query constructs ordered Agent input but does not own provider details.
The model runtime internally owns typed-message rendering and protocol
sanitation. Isolated model calls that do not consume canonical history, such as
routing-manifest initialization and context compaction, remain self-contained.

## Package boundaries

```text
agent/messages/
  metadata.ts        lane and delegation-scope metadata
  query.ts           immutable canonical message query
  protocol.ts        provider tool-call sequence sanitation
  reconciliation.ts private-message reconciliation primitive

agent/orchestrator/delegation/
  briefing.ts        Orchestrator -> Capability current request
  privateMessages.ts returned-message reconciliation and typed Announce materialization
  announceMessage.ts typed Capability -> Orchestrator result
  announce.ts        exact-scope Announce selection
  handoff.ts         acceptance into main and private-message cleanup

agent/orchestrator/modelInvocation.ts
  internal model-call wiring for typed rendering and protocol sanitation

agent/orchestrator/runSupervisor/
  input.ts           OrchestratorState -> RunSupervisorInput
  protocol.ts        control-command contract
  session.ts         run-scoped Supervisor state
  runner.ts          Supervisor execution boundary
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
5. Briefing, Toolkit context, and Supervisor provider messages never enter root
   `messages`.
6. Supervisor Boundary receives typed Announce evidence, not raw private messages.
7. Handoff accepts typed Announces and clears the matching private messages.
8. One query owns history selection and invocation-local append order; the
   internal model runtime owns provider protocol details.

## Validation

- query tests cover chronology, immutability, exact scope, and diagnostics;
- Capability tests cover fresh-task isolation and same-delegation continuation;
- Supervisor tests cover Entry and Boundary input shapes;
- model-invocation tests cover typed rendering, state immutability, and the real
  Agent/direct-model boundaries;
- Boundary tests prove ordered Announce evidence without raw private messages;
- full typecheck, unit tests, context audit, and targeted real-model evals pass.

## Non-goals

This refactor does not change Supervisor decision policy, search budgets, command
actions, Announce semantics, user-facing answer policy, or artifact state.
