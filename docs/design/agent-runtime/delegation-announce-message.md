# Delegation Announce message and projection draft

Status: working design.

## Goal

Preserve a delegated Capability's execution result as a distinct domain fact
from the moment the delegation stops until the result is consumed by another
model or rendered to the user.

The runtime must let a model and the UI distinguish all of the following:

- a result produced by a delegated Capability;
- the orchestration action that transfers that result to the main lane;
- a later assistant answer that synthesizes one or more results.

This contract fixes the semantic structure. Provider-specific message shapes,
prompt wording, and UI presentation may evolve without changing that structure.

## Problem

The previous lane protocol marked the delegated result inside the Capability
lane, but handoff copied its text into a new, unlaned `AIMessage`. Provenance
was held only in incidental `additional_kwargs` metadata.

That metadata is useful to runtime code but is not reliably visible to a model.
After the copy reaches the main conversation, the model can therefore see the
Capability result as ordinary assistant prose. A later Answer is also ordinary
assistant prose. The two messages have different meanings but an equivalent
model-visible shape.

This ambiguity can cause Entry Answer or another orchestration model to deny
that execution occurred, reinterpret an accepted result as a previous assistant
claim, or answer from the wrong message. It also forces stream and UI code to
infer servant provenance from incidental metadata.

## Terminology

The protocol uses four separate concepts:

- **Announce** is the immutable fact emitted when one delegation invocation
  stops. It contains the delegated result and its provenance.
- **Handoff** is the orchestration operation that accepts and transfers an
  announce from a delegation lane to the main lane. Handoff is not a message
  role and does not rewrite the result.
- **Projection** converts an announce for a particular consumer. Model and UI
  projections have different output types.
- **Answer** is user-facing synthesis. It may use accepted announces, but it is
  not itself execution evidence and does not replace them.

## Decision

Introduce `DelegationAnnounceMessage` as the canonical domain message for a
delegated execution result.

```ts
type DelegationAnnounceMessageData = {
  version: 1;
  sourceLane: MessageLane;
  delegationId: string;
  transcriptRunId: string;
  announceMessageId: string;
  task: string | null;
  completionReason: SubagentCompletionReason;
  result: string;
  createdAt: string;
};
```

`DelegationAnnounceMessage` is an AIMessage-compatible internal domain class.
Its semantic type is the versioned `pinpawo.delegationAnnounce` payload, not a
custom provider role. It serializes as LangChain's standard `AIMessage`, so the
existing checkpoint serde can restore it; the announce reader recognizes the
payload after restoration. It may exist in graph state and be inspected by
runtime code, but it must never be passed directly to a chat model adapter.

The stable identity of the announce is `announceMessageId`. Projection does not
allocate a new semantic identity. `sourceLane` records where execution occurred;
it is distinct from the message's current queue placement. `transcriptRunId`
identifies the execution transcript that produced the announce.

The result is untrusted data produced by a delegated executor. It is not a
system or developer instruction, even if its text contains instruction-like
content.

## Lifecycle

```text
Capability lane
  -> DelegationAnnounceMessage
  -> handoff accepts the same announce identity into the main lane
     -> model projection -> provider-compatible standard message
     -> UI projection    -> servant result event/card
     -> Answer input     -> accepted-result synthesis
```

The Capability lane owns producing the announce. The root graph owns accepting
it through handoff. Consumer boundaries own projection. Answer owns synthesis.

Handoff removes the delegation transcript according to existing lane cleanup
semantics, but it must not flatten the announce into an ordinary `AIMessage`.
The graph reducer may replace the lane-owned physical message with a main-queue
physical message, but both carry the same `announceMessageId` and typed data and
must never coexist after the handoff update. There is one canonical announce,
not an original plus a main-queue text copy.

## Model projection

Every model invocation that can receive main-conversation messages must pass
them through one shared projection function before calling the model. The
function converts `DelegationAnnounceMessage` into a standard provider-supported
message while leaving canonical state unchanged.

The initial model-visible envelope is:

```text
<delegation_announce version="1" role="data">
  <source lane="capability:example" delegation_id="..." run_id="..." />
  <task>...</task>
  <completion reason="natural" />
  <result format="markdown">...</result>
</delegation_announce>
```

The projection uses a standard `AIMessage` because the provider adapters only
accept standard chat roles. The envelope, rather than hidden
`additional_kwargs`, makes the delegated source visible to the model.

Projection must:

- preserve the announce's chronological position;
- include source, task, completion reason, and result;
- escape structural delimiters in all data fields;
- clip fields using explicit context-budget limits;
- state through `role="data"` that result text is evidence, not instruction;
- retain provenance in metadata for tracing, without relying on that metadata
  for model understanding;
- return a new ephemeral message and never write it back to graph state.

The runtime must not represent an announce as a custom provider role, a
`SystemMessage`, or a standalone `ToolMessage`. A custom role is not portable;
a system role would give delegated data excessive authority; and a tool result
without a preceding tool call violates provider tool-message protocols.

The XML-like envelope is a versioned model projection, not the canonical state
schema. Its labels and required fields are stable for version 1. Cosmetic prompt
text outside the envelope is not part of this contract.

## UI and stream projection

The stream adapter projects the same canonical announce as a servant result,
using the existing public subagent/Capability event vocabulary where possible.
The projection exposes:

- servant or Capability identity;
- delegated task;
- completion reason or display status;
- result content;

Internal identifiers may remain available in diagnostics but do not need to be
shown in the normal UI. The UI projection must not append another assistant
message to canonical conversation state.

An Answer generated after the announce remains a normal user-facing assistant
message. The UI may therefore show one servant result followed by one main-agent
Answer without presenting two indistinguishable assistant replies.

## Answer and Entry Answer behavior

Result Answer continues to select accepted delegation results from orchestrator
state and project them through its accepted-results context. It should read the
canonical announce fields rather than reverse-engineering provenance from an
ordinary `AIMessage`.

Entry Answer and any other model that receives main-conversation history use the
shared model projection. They can then distinguish a real delegated execution
result from a previous user-facing Answer. Presence of an accepted announce is
execution evidence; an Answer summary alone is not.

The design does not require Entry Answer to reproduce the announce verbatim. It
requires only that the model-visible input preserve the fact, source, and result
of the execution so the model can answer or route accurately.

## State and ownership invariants

- One delegation stop produces at most one canonical announce identity.
- Handoff transfers or accepts that identity; it does not generate a second
  ordinary assistant message containing the same result.
- Canonical state retains the typed announce. Model and UI messages are derived
  views and are never persisted as replacements for it.
- A delegated result always reaches the model with explicit servant/Capability
  provenance in model-visible content.
- Delegated result content always has data authority, never system or developer
  authority.
- Answer may summarize, combine, or qualify announces, but cannot become their
  canonical source of truth.
- Lane isolation and existing resume/supersede ownership remain unchanged.

## Version boundary

This is an intentional checkpoint contract boundary. Only a version 1
`pinpawo.delegationAnnounce` payload is execution evidence. Old unlaned
`AIMessage` handoff copies are ordinary conversation history: they are not
normalized, projected as servant results, or selected by Answer.

No checkpoint migration is provided. Sessions with an old handoff should start
a fresh task if they need the execution result to participate in later routing.

New checkpoints must preserve the versioned announce payload. Restoring the
portable message class as an ordinary `AIMessage` is valid only because the
reader reconstitutes its announce semantics from that payload; a restore that
loses or corrupts the payload is incompatible with the new writer.

## Implementation boundaries

The implementation should keep responsibilities separated:

- `messageLanes.ts` recognizes lane ownership and announce identity;
- a dedicated announce module owns the class, validation, and model projection;
- handoff code owns acceptance and lane cleanup, not presentation formatting;
- model nodes call one shared conversation projector before model invocation;
- stream adapters own UI projection;
- Answer resolves accepted announces and owns final synthesis.

Artifacts remain independent capability state. They are not part of the
announce contract or its model/UI projection.

## Non-goals

This design does not:

- remove message lanes or merge servant transcripts into the main conversation;
- introduce a provider-specific custom chat role;
- change Planner search, terminal semantics, delegation completion policy, or
  active-delegation boundary routing;
- expose all internal trace metadata to users;
- make delegated result text trusted instructions.

## Validation

Implementation is complete only when tests demonstrate:

- `DelegationAnnounceMessage` survives checkpoint serialization and restore with
  its type, identity, and result intact;
- no custom internal message reaches a provider adapter;
- the model input contains explicit announce provenance and a safely escaped
  result envelope;
- handoff leaves one canonical announce and no duplicate ordinary result copy;
- a servant result and its later Answer are distinct in stream/UI output;
- tool-call message ordering remains provider-valid;
- context compaction retains announce provenance when it retains or summarizes
  the result;
- the captured Entry Answer regression case recognizes that Capability execution
  occurred instead of reporting that no real execution happened.

Prompt behavior must be covered by model evals or observable structured
behavior, not tests that assert literal projection prose.
