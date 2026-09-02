# Agent model context assembly

Status: proposed design. This document defines context ownership and assembly
boundaries only. It does not describe an implemented migration.

## Problem

Agent model calls currently receive context through several mechanisms:

- a System Prompt selected or modified by the caller;
- canonical messages selected from Agent state;
- current facts appended as temporary Human messages;
- provider-specific message projection and protocol repair.

Those mechanisms are individually useful, but their ownership is easy to blur.
A prompt helper can start selecting messages, a message helper can start
inventing domain context, or a middleware can become responsible for business
decisions merely because it is close to the model call.

The design goal is to give every model invocation one recognizable assembly
shape without introducing a universal prompt manager or model-request object.

## Decision

Every Agent model invocation has three independent context channels:

| Channel | Question | Provider representation |
|---|---|---|
| **System Policy** | What must the model obey? | one rendered `SystemMessage` or equivalent `systemPrompt` |
| **Conversation History** | Which existing interactions may the model see? | canonical messages selected by `queryAgentMessages()` |
| **Invocation Context** | What typed facts apply to this invocation? | domain-rendered, invocation-only messages appended after history |

```text
typed domain state/input
  +-> select domain template + derive typed vars
  |     `-> render System Policy ----------------------------+
  |
  `-> canonical messages + typed current facts              |
        +-> query lanes -> Conversation History ------------+-> existing model boundary
        `-> domain renderer -> Invocation Context -----------+
```

The channels may derive from the same validated domain input. They do not read
one another's rendered output and meet only at the existing model boundary.
Conversation History and Invocation Context may be empty. A closed maintenance
call, for example, has one fixed System Policy, no conversation history, and one
explicit data input.

## Standard construction shape

A model-calling domain performs these steps explicitly:

1. start from typed domain state or typed invocation input;
2. select a domain-owned System Prompt template;
3. derive only the variables declared by that template;
4. if canonical history is needed, select it with `queryAgentMessages()`;
5. render domain-owned current facts and append them through the query;
6. pass the completed System Policy and message list to the existing model
   boundary.

```ts
const systemPrompt = DOMAIN_SYSTEM_PROMPT.render(
  deriveDomainSystemPromptVars(input),
);

const messages = queryAgentMessages(state.messages)
  .main()
  .append(buildDomainInvocationContext(input))
  .select()
  .messages;

await existingModelBoundary({ systemPrompt, messages });
```

This is a common expression, not a new shared pipeline object. Domains retain
their current model consumer: a root node may call a model directly, Capability
execution may call its executor runtime, and a maintenance transform may use a
closed model call.

## System Policy

System Policy contains trusted, code-owned instruction:

- Agent or node objective;
- decision policy;
- registered Capability and Toolkit instructions;
- provider output protocol.

Each domain owns its template and typed render variables. Simple interpolation
and a more involved builder are the same operation conceptually:

```text
typed domain input -> declared template vars -> domain template -> System Policy
```

Do not introduce a shared array of pre-rendered sections such as
`{ id, source, owner, content }`. Section metadata is useful for diagnostics,
but it must not become the construction model passed across domains.

### Variants

A finite, typed discriminator may select a System Prompt variant. Planner
`entry | boundary` is the reference case:

```text
CapabilityPlannerInput.mode
  -> select entry or boundary template
  -> derive that template's vars
  -> render System Policy
```

This design does not prescribe where that selection is executed. In particular,
it does not require separate Agent instances, different middleware, or a change
to tool registration. Existing domain control flow remains intact unless a
separate design explicitly changes it.

A variant must not be inferred from conversation text, tool output, Announce
prose, or another rendered prompt.

## Conversation History

Conversation History is the only channel that reads canonical Agent messages:

```ts
const history = queryAgentMessages(state.messages)
  .main()
  .delegation(scope)
  .select();
```

The query owns selection, delegation scope, and canonical chronology. It does
not own:

- System Prompt construction;
- Planner or Delegation semantics;
- current runtime facts;
- domain XML or other visible schemas;
- provider output protocol;
- task completion decisions.

The lane/query contract remains defined by
[`agent-message-lanes.md`](agent-message-lanes.md). This design does not add a
second canonical message collection, transcript object, manager, or view model.

Canonical history must not silently become another System Policy channel.
Ingress behavior for legacy or caller-supplied `SystemMessage` values is a
separate migration decision; it must be reviewed explicitly rather than being
introduced as an incidental implementation detail.

## Invocation Context

Invocation Context contains typed facts that the model must know or process for
one invocation:

- Planner Entry or Boundary input;
- Delegation briefing;
- workdir and runtime-environment facts;
- available optional-interface facts;
- current plan and Announce evidence;
- finalization or review facts.

The owning domain defines the model-visible structure. The shared message layer
may stamp common metadata and place the message after selected history, but it
does not invent one payload schema for unrelated domains.

```ts
const messages = queryAgentMessages(state.messages)
  .main()
  .delegation(scope)
  .append(domainInvocationContext)
  .select()
  .messages;
```

The provider `HumanMessage` role is transport, not user authority. An
invocation-only message should be identifiable as synthetic and
non-authoritative. Appending it for a call does not imply persistence into
canonical history.

## Placement rule

> Content that changes what the model must obey belongs to System Policy.
> Content that changes what the model knows or must process now belongs to
> Invocation Context. Existing interaction belongs to Conversation History.

| Content | Channel |
|---|---|
| Agent identity, objective, and decision policy | System Policy |
| Capability and Toolkit instructions | System Policy variables |
| Structured-output protocol | System Policy variable |
| User goal, task, plan, Announce, and execution evidence | Invocation Context |
| Workdir and runtime environment | Invocation Context |
| Existing main and delegation-private messages | Conversation History |
| Message or tool prose proposed as policy | rejected |

Capability execution is the strongest legitimate intersection:

```text
validated active delegation + compiled Capability
  +-> Capability/Toolkit data -> System Policy vars
  +-> delegation scope        -> Conversation History query
  `-> task and runtime facts  -> Invocation Context
```

The typed source is shared; the rendered channels are not.

### Target shapes by domain

This table fixes placement, not implementation mechanics:

| Model call | System Policy | Conversation History | Invocation Context |
|---|---|---|---|
| Entry Answer | Entry template | main | none |
| Planner | entry/boundary template | main | typed Planner input |
| Capability | Framework + Toolkit + Capability instructions | main + exact delegation | runtime facts + briefing |
| Finalization | finalization template | none | closed terminal facts |
| Auto Review | review + registered Toolkit policy | none | action facts |
| Compaction | fixed maintenance policy | none | explicitly selected old history as data |

These shapes do not authorize changing the existing node, Agent, middleware, or
tool topology used to produce them.

## Provider boundary

Provider handling is downstream of context assembly. It may:

- project typed domain messages into provider-compatible messages;
- repair tool-call and ToolMessage ordering;
- apply provider transport requirements.

It must not select lanes, reinterpret domain facts, or add business policy.
Provider projection is not a fourth context channel.

## Scope guardrails

Implementing this design must not, by itself, change:

- the number or lifetime of Planner, Capability, or root Agent instances;
- graph routing or node topology;
- terminal-tool availability, filtering, or commit semantics;
- Planner search accounting or retry behavior;
- middleware lifecycle responsibilities unrelated to context assembly;
- run-scoped or checkpoint state semantics;
- model fallback, completion, or error behavior;
- public runtime APIs unless that API change is reviewed separately.

If an implementation appears to require one of these changes, split it into a
separate design and PR. Behavioral equivalence should be demonstrated at the
existing model boundary before further cleanup.

## Suggested migration sequence

Each step should be independently reviewable and preserve runtime behavior:

1. inventory existing model calls and classify their current inputs into the
   three channels;
2. normalize domain Prompt templates and typed render variables without moving
   mode selection, tools, or middleware control;
3. standardize invocation-only message metadata and placement without changing
   visible domain payloads;
4. move trusted Capability/Toolkit instruction assembly behind a domain-owned
   builder without changing the executor contract in the same PR;
5. consider public API or canonical-ingress changes only as separate follow-up
   proposals.

Reference documentation should continue describing the shipped implementation
until each migration step lands. It must not be updated in advance to describe
this proposal as current behavior.

## Non-goals

This design does not introduce:

- a generic Prompt manager;
- a universal `prepareModelRequest` or model-context object;
- a second message collection;
- a shared XML schema for unrelated domains;
- a new Agent or middleware lifecycle;
- Planner, delegation, or finalization behavior changes.

It standardizes how existing domains express model context while leaving their
execution logic and visible contracts unchanged.
