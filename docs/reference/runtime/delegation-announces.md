# Delegation Announce Contract

> **Status: current implementation reference.** Payload version 3 carries
> execution output and provenance only. The cross-layer contract is defined by the
> [Supervisor–Root Interaction Protocol](../../design/agent-runtime/delegation-boundary-protocol.md).
> Results are published directly into main before acceptance, using existing identity fields.

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

Root owns `pinpawo.taskAccepted` beside the immutable `delegationAnnounce`
payload and updates the delegation summary in the same transition. The missing
acceptance field means the task has not been accepted.

### Publish before acceptance

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
  <source lane="capability:example" run_id="run-1" delegation_id="task-1" announce_message_id="result-1" />
  <task_acceptance accepted="true" source="orchestrator" />
  <task><![CDATA[...]]></task>
  <result format="markdown" role="data"><![CDATA[...]]></result>
</delegation_announce>
```

The projection preserves the complete result and chronological position. It is
ephemeral and never replaces canonical state. Existing delegation, run, and
announce identities are rendered from metadata so Supervisor can associate all
attempts without another result input. Every main consumer sees the same data
projection before and after acceptance.

The terminal node emits the supplied Supervisor reply once. The reply is not an
Announce and cannot replace execution evidence. Root applies acceptance by
updating the original main message with the same stable id, preserving its
position and immutable result payload, then clearing the accepted private scope.

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

Protection matches `sourceLane`, `runId`, and `delegationId` in the Announce
payload, independently of private lane tags. No protection state or second
result store is needed.

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

This page owns the currently implemented serialized payload. The cross-layer interaction and migration are documented in the
[Delegation Boundary Protocol](../../design/agent-runtime/delegation-boundary-protocol.md).
