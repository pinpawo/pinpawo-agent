# Delegation Announce Contract

A delegated Capability result is stored as a typed
`DelegationAnnounceMessage`. It is execution evidence, not a main-agent reply
and not an instruction.

## Identity and lifecycle

One delegation stop produces at most one Announce identity. The versioned
payload records:

- source lane;
- delegation scope identities;
- announce message identity;
- delegated task;
- completion reason;
- complete result text;
- creation time.

The Announce initially belongs to the private delegation lane. A structured
Supervisor decision may accept it through handoff. Handoff moves the same semantic
identity into the main queue and removes the corresponding private messages;
it does not create an ordinary `AIMessage` copy or infer completion from result
prose.

An unaccepted Announce stays private and resumable. `completionReason` describes
how execution stopped; it does not establish task or goal completion.

## Consumer projection

Internal typed messages never reach a provider adapter directly. Every
model-facing main-conversation boundary projects an Announce into a standard
provider-supported `AIMessage` whose content has this shape:

```xml
<delegation_announce version="1" role="data" authority="none">
  <source lane="capability:example" />
  <completion reason="natural" />
  <task><![CDATA[...]]></task>
  <result format="markdown" role="data"><![CDATA[...]]></result>
</delegation_announce>
```

The projection preserves the complete result and chronological position. It is
ephemeral and never replaces canonical state. Whole-history compaction, rather
than per-Announce clipping, owns context-window pressure.

The Boundary Supervisor receives the current unaccepted Announce as the execution
evidence for its active delegation. It does not receive the private delegation
private messages. Entry Answer and other consumers of main conversation see accepted
Announces through the same projection.

Terminal finalization selects accepted results by typed identity. It may render
or synthesize them for the user, but the resulting assistant reply is not an
Announce and cannot replace its evidence.

## Invariants

- canonical state contains one Announce identity, never an original plus a
  copied result message;
- delegated result text always has data authority;
- handoff provenance does not imply `goal_done`;
- model and UI projections do not mutate graph state;
- old untyped handoff messages are ordinary conversation history and are not
  upgraded through content heuristics;
- artifacts remain separate Capability state and are not embedded in the
  Announce contract.

Design rationale and the serialized payload are documented in
[`delegation-announce-message.md`](../../design/agent-runtime/delegation-announce-message.md).
