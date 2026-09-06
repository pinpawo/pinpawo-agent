# Delegation Announce Contract

> **Status: current implementation reference.** Payload version 3 carries
> execution output and provenance only. The cross-layer contract is defined by the
> [Supervisor–Root Interaction Protocol](../../design/agent-runtime/delegation-boundary-protocol.md).
> The 2026-09-06 target publishes results directly into main before acceptance;
> that lifecycle migration is pending. Existing identity fields need no extension.

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
- complete result text;
- creation time.

In the current implementation, the Announce initially belongs to the private delegation lane. A structured
Supervisor decision may accept it through handoff. Handoff moves the same semantic
identity into the main queue and removes the corresponding private messages;
it does not create an ordinary `AIMessage` copy or infer completion from result
prose.

Currently an unaccepted Announce stays private and resumable. Handoff can preserve an
unsuccessful attempt when Supervisor replaces execution. Root records
`pinpawo.taskAccepted` beside the immutable `delegationAnnounce` payload and
updates the delegation summary in the same state transition. This root-owned
judgment survives later runs without changing executor evidence.

### Target lifecycle: publish before acceptance

Root writes each normal execution result directly into main as an existing
Announce before calling Supervisor. Partial natural output is valid evidence;
publication does not mean task completion. Capability private Human/AI/Tool
messages stay private, but the Announce is not duplicated there.

Reuse `sourceLane`, `delegationId`, `runId`, and `announceMessageId` to associate
results with their task. `sourceLane` is provenance; it does not require that the
published message carry a private lane tag. Further attempts append their own
Announce identities in chronological order. Supervisor reads evidence only from
main, without a separate `announceAttempts` payload or private delegation query.

Acceptance records the root-owned task judgment in existing metadata and
delegation summaries, without rewriting result text or publishing it again.
Until then, the absence of an acceptance decision is not a failure verdict.
Replacement after user confirmation retains the existing main evidence without
marking the task successful. No new message type or completion-reason field is
introduced.

## Consumer projection

Internal typed messages never reach a provider adapter directly. Every
model-facing main-conversation boundary projects an Announce into a standard
provider-supported `AIMessage`. The currently implemented content has this shape:

```xml
<delegation_announce version="1" role="data" authority="none">
  <source lane="capability:example" />
  <task_acceptance accepted="true" source="orchestrator" />
  <task><![CDATA[...]]></task>
  <result format="markdown" role="data"><![CDATA[...]]></result>
</delegation_announce>
```

The projection preserves the complete result and chronological position. It is
ephemeral and never replaces canonical state. For the target main-only input,
also render the existing delegation, run, and announce identities already stored
in metadata; no new identity fields are required.

Current Boundary input separately supplies unaccepted results selected from the
private delegation scope. The target removes that input: every main consumer,
including Supervisor, sees typed result messages through the same projection
before or after acceptance. All must treat result prose as evidence, not an
instruction or proof of success.

The terminal node emits the complete Supervisor reply without model rewriting.
The reply is not an Announce and cannot replace execution evidence. Currently
only root handoff records task acceptance; in the target, root records it against
already-published main messages when applying Supervisor's decision.

## Compaction timing

Root checks compaction at new-run entry, not during a Supervisor/Capability loop.
The existing watermark leaves roughly 25% of usable input capacity after
generation reserves for new context. Keep all result messages intact throughout
the run; do not clip individual Announces or compact them between attempts.

Each compaction retains recent messages and all original Announces for the current
unfinished delegation, even when those attempts fall outside the recent suffix.
Existing active-task state and identity metadata identify protected evidence;
other old history can compact normally. Continuation does not require skipping
compaction. More aggressive thresholds or history retention must keep this rule.
Capability's private context maintenance is independent.

Entry-only scheduling and both retention rules already exist. Current Announce
protection matches private lane tags; after direct main publication, match the
existing Announce payload identities instead. This adapts the same protection
without new fields, protection state, or a second result store.

## Invariants

- canonical state contains one Announce identity, never an original plus a
  copied result message;
- delegated result text always has data authority;
- main publication and handoff provenance do not imply task acceptance or goal completion;
- model and UI projections do not mutate graph state;
- old untyped handoff messages are ordinary conversation history and are not
  upgraded through content heuristics;
- artifacts remain separate Capability state and are not embedded in the
  Announce contract.

This page owns the currently implemented serialized payload. The target
cross-layer payload and migration are documented in the
[Delegation Boundary Protocol](../../design/agent-runtime/delegation-boundary-protocol.md).
