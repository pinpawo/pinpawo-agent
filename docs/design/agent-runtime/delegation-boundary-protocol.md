# Delegation Boundary Protocol

Status: working design for issue #755.

## Goal

Define one coherent contract for how a Capability subagent leaves execution,
when its output becomes a Delegation Announce, how the Run Supervisor evaluates
that output at a Boundary, and which minimal control commands may change root
orchestration state.

This document owns the cross-layer protocol between Capability execution and the
Run Supervisor. It does not own Supervisor session storage, message-lane mechanics,
final response rendering, or interruption recovery.

## Document ownership

The related documents have non-overlapping responsibilities:

| Document | Owns |
| --- | --- |
| This document | Capability exit, target Announce payload and eligibility, Boundary entry, acceptance, and Supervisor control effects |
| [Run-scoped Supervisor session](run-scoped-supervisor-session.md) | Supervisor run scope, semantic session state, provider context, disclosure, and replay |
| [Current Delegation Announce reference](../../reference/runtime/delegation-announces.md) | Implemented Announce version, storage, handoff, and consumer projection until the #755 migration lands |
| [Context injection map](../../reference/runtime/context-injection-map.md) | Implemented canonical message ownership, exact delegation selection, and model-visible context |
| [Guard design](../../reference/runtime/guards.md) | Internal deterministic guard decisions and diagnostic records |
| Interruption designs | Review, pause, cancellation, and later resumption |
| Future Finalizer topic | User-visible terminal projection and run cleanup; intentionally not specified by this draft |

When another document needs to explain the complete Capability-to-Supervisor
flow, it links here instead of restating the exit or command policy.

## Problem

The current implementation crosses the Capability boundary with
`completionReason`. In practice, normal returns use `natural`, the subagent
iteration guard uses `limit_reached`, interruption has moved to Runtime-private
control flow, and other exceptions are thrown. This leaves a stop-mechanism hint
inside the result, Announce, Supervisor input, provider projection, finalization,
and handoff policy even though none of those consumers should use it to decide
whether the task is complete.

The current Supervisor command set also mixes two kinds of output:

- orchestration effects such as committing a plan or continuing a delegation;
- user-facing conclusions such as goal completion, missing user input, or lack
  of an executable Capability.

That mixture creates overlapping policy in the system prompt, tool descriptions,
argument schemas, command parser, root materializer, and finalizer. It also fails
to express some valid combinations, such as accepting a completed current task
while reporting that an independent remaining task cannot proceed.

## Principles

1. A Capability result describes what the executor produced, not why its loop
   stopped and not whether the task is complete.
2. The Supervisor is the only model-driven owner of semantic task acceptance.
3. Root validates identity, shape, scope, and legal effects. It does not infer
   completion from result prose or runtime stop metadata.
4. Exceptions are not results and must not be disguised as Announces.
5. Supervisor commands describe root state changes. User-facing conclusions
   belong to natural Supervisor output and terminal finalization.
6. Internal guard reasons remain available to telemetry and diagnostics without
   becoming Capability-to-Supervisor protocol fields.
7. Private Capability Human, AI, and Tool messages never enter Supervisor input
   or the main conversation.

## Capability exit contract

Capability execution has three relevant exits:

| Exit | Deliverable | Root behavior |
| --- | --- | --- |
| Execution stopped and selected a new deliverable | yes | Materialize one plain typed Announce and enter the Supervisor Boundary |
| Recoverable execution failure without a deliverable | no | Do not create an Announce; preserve recoverable task ownership and expose the failure to the user |
| System-level failure | no | Do not create an Announce or invoke Supervisor; surface the system error |

Review, pause, cancellation, and unexpected interruption are owned by the
interruption design. They do not become additional result exits in this
protocol.

### Internal stop mechanisms

Natural model return, an internal model-call guard, or another clean subagent
loop stop may all reach the first row when a new deliverable exists. The
Capability adapter selects the deliverable by message identity and materializes
the same Announce shape in every case.

The subagent iteration guard may retain its stop marker and decision record for
private Runtime diagnostics. It does not add a `completionReason` field to
`SubagentResult`, Announce, or Supervisor input.

If the guard stops an invocation before any new deliverable exists, the adapter
must not fabricate an empty result or send a Boundary with absent execution
evidence. That condition is a recoverable execution failure.

### Tool failures

A Toolkit operation error represented in private Tool/AI history may be handled
by the Capability model. If the model produces a deliverable explaining the
result, the normal Announce path applies. An uncaught Tool, Capability Runtime,
model, summarization, or finalize exception stays on the error path and does not
become result prose.

## Announce contract

The target cross-layer payload contains only result identity, provenance, and
content:

```ts
type DelegationAnnounceData = {
  version: 3;
  sourceLane: CapabilityMessageLane;
  delegationId: string;
  runId: string;
  announceMessageId: string;
  task: string | null;
  result: string;
  createdAt: string;
};
```

There is no `completionReason`, `accepted`, `progress`, `taskCompleted`, or
error field. Acceptance is a later root transition. Errors use the error
channel. Progress and completeness remain Supervisor judgments over the task and
ordered result evidence.

## Boundary entry

A normal post-execution Boundary requires all of the following:

- an active delegation identified by exact lane, `runId`, and `delegationId`;
- at least one typed, still-unaccepted Announce in that scope;
- one newest Announce identity marked as the evaluation target;
- the current run-scoped Supervisor session.

Conceptually:

```text
Capability deliverable
  -> lane-scoped DelegationAnnounceMessage
  -> Boundary projection
       active task
       ordered announce attempts
       latest evaluation target
       prior remaining-plan proposal
  -> Supervisor judgment
```

Resume without new result evidence is owned by the existing recovery path. It
does not create a Supervisor Boundary or a third Supervisor mode. This topic
does not prescribe recovery routing. Normal Boundary inputs have a non-null
latest target and do not carry `evidence_state` or an availability flag.

The Supervisor receives all ordered Announces because the latest attempt is not
assumed to be cumulative. It does not receive the Capability's private tool or
reasoning transcript.

## Acceptance and handoff

Handoff preserves an execution record in main history. Task acceptance records
the Supervisor's judgment that the active task is satisfied. These are separate
effects: replacement may hand off a failed attempt without accepting its task.
Neither effect rewrites the immutable Announce payload.

Acceptance is an explicit root effect proposed by Supervisor and materialized by
the Orchestrator:

- move the accepted typed Announce identities into the main conversation;
- clear the exact private delegation scope;
- mark the delegation summary completed;
- clear or replace the active delegation;
- preserve Announce content without synthesizing a different result.

Internal stop diagnostics cannot veto an acceptance command. If an execution
produced an Announce, Supervisor judges it from the task and result evidence.

`continue_current` is the complementary non-accepting effect. It preserves the
exact delegation identity, task, private messages, and prior remaining plan for
another autonomous Capability attempt.

It may carry optional natural-language feedback explaining the missing evidence
or correction. The next invocation includes that feedback in its current
briefing. Feedback does not replace the task, enter main history, or create a
persistent Supervisor memory field. Runtime retains the pending invocation input
only as required to deliver or replay that execution request.

## Supervisor control surface

The target control surface is organized by state effect rather than terminal
reason.

One Supervisor invocation may deliver at most one control proposal to root.
Discovery tools may run repeatedly and update disclosure. Control tools propose
root effects and end the Supervisor invocation; they do not themselves mutate
main messages, accept tasks, or dispatch Capability execution.

Root validates the proposal and applies its related effects in one state
transition before routing to execution or finalization. A successful control
call is not fed back to the model for another generation round.

Validate the complete model response before executing control calls. If it
contains multiple control proposals, apply none of them. The Supervisor adapter
may request a corrected response within its existing invocation budget; exhausted
or unusable output follows the protocol-error path. Disabling parallel tool calls
is an aid, not the invariant. Mixed discovery/control responses must likewise be
validated before effects; their exact eligibility is an open design question.

### Required effects and scenarios

The tool names, count, and argument schema remain open. The protocol must express
these cases with one control proposal, without introducing completion-reason
categories or sequential partial root commits:

| Situation | Required root effects |
| --- | --- |
| Initial executable work | Commit and dispatch an executable plan |
| Current task complete, more work | Accept current task and dispatch the next plan |
| Current task complete, clarification needed next | Accept current task and deliver the question; dispatch no work |
| Current result incomplete, same executor can fix it | Continue exact delegation with optional feedback |
| Current attempt unsuitable | Replace execution without marking the old task successful; preserve its result evidence |
| Current work incomplete and needs user help | Deliver the question and preserve unfinished ownership |
| All requested work complete | Accept current task and deliver the final response |

Handoff of execution evidence does not imply task success. Replacing execution
must not silently accept the old task. How this distinction is represented in
existing summaries and selectors must be settled before implementation, without
adding model-visible outcome flags merely for routing.

### Minimum terminal interface

Without a control proposal, usable natural final text ends the invocation and
passes to the existing terminal node. It does not implicitly accept a task or
start the remaining plan. When acceptance and a reply are both needed, they must
be conveyed by the single proposal; its exact reply representation remains open.

The terminal node should project the complete supplied reply once into main and
perform run cleanup, without classifying prose into reasons or invoking a model
merely to rewrite it. The wider Finalizer redesign remains deferred. An invocation
with neither a valid control proposal nor usable final text is a protocol failure.

### Replay and next-session design work

Caching a decision avoids a repeated model decision; it does not by itself prevent
repeated root effects. Inspect existing graph checkpoint and tool/Command routing
before deciding whether the current last-command cache is needed. Do not introduce
a separate per-tool effect ledger in this draft.

The next design session should resolve, in order:

1. Where the current control tool calls yield to root, and whether multiple calls
   can apply effects before the invocation ends.
2. The smallest single-proposal schema covering the scenarios above, including
   replacement and acceptance with a natural reply.
3. Whole-response validation, including mixed discovery/control calls, and the
   mechanism that ends the invocation immediately after a control proposal.
4. Atomic root materialization and existing checkpoint replay guarantees; retain
   custom replay state only for an identified gap.
5. The minimum terminal interface, then the system prompt, tool descriptions,
   argument descriptions, behavior tests, and real-model evaluations together.

### State visible to Supervisor

The model needs the user goal, current task if any, ordered results, proposed
remaining work, and available Capability documents. IDs, replay keys, revision
counters, error classification, and continuation storage belong to runtime.
Only result identity needed to distinguish attempts is projected as context;
the model does not supply runtime identity fields in control-tool arguments.

## Message visibility

| Data | Supervisor | Active Capability | Other Capability | Main conversation |
| --- | --- | --- | --- | --- |
| User and ordinary main messages | visible | visible | visible | canonical |
| Handed-off typed Announces (successful or unsuccessful execution evidence) | visible | visible | visible | canonical |
| Current unaccepted Announces | Boundary only | visible in own scope | hidden | private |
| Private Capability Human/AI/Tool history | hidden | visible in own scope | hidden | private |
| Intermediate Supervisor model/search/tool messages | current invocation only | hidden | hidden | never stored in main |
| Final natural Supervisor reply | ordinary main history on later invocations | visible through main | visible through main | one assistant reply |
| Guard stop diagnostics | hidden; telemetry only | Runtime-private | hidden | never stored as result |

## Error boundary

The Orchestrator already has a node-error cleanup and rethrow boundary. The Host
already distinguishes narrowly defined fatal model failures from recoverable
run failures. This topic should reuse those paths rather than create Supervisor
failure commands or additional long-lived routing flags.

The user-facing error contract must preserve the original diagnostic for
operators while giving the user a concrete next action. Fatal system errors are
not rewritten as ordinary assistant replies.

The detailed continuation behavior after an error belongs to the interruption
and recovery topic. This protocol only requires that an exception bypasses
Announce acceptance and normal Boundary evaluation.

## Migration

1. Remove `completionReason` from `SubagentResult`, typed Announce data,
   Supervisor Boundary input, provider projection, handoff policy, and finalizer
   facts.
2. Keep internal guard stop markers and decision records only where diagnostics
   or private control flow still need them.
3. Route a guard stop with a selected deliverable through the ordinary Announce
   path; make a stop without a deliverable a recoverable execution failure.
4. Remove root acceptance vetoes derived from internal stop metadata.
5. Separate acceptance from plan dispatch; preserve unsuccessful execution
   evidence on replacement and support feedback on exact-delegation continuation.
6. Add the minimum natural-text terminal interface and verify single-proposal replay, then
   remove the old control commands together so no competing protocol remains.
7. Update current reference documentation after each implementation step lands.

## Validation matrix

Behavior tests and targeted model evals must cover:

- natural return with a deliverable enters Boundary without a stop reason;
- guard stop with a deliverable enters the same Boundary shape;
- guard stop without a deliverable raises a recoverable execution failure;
- a handled Tool error may still produce a normal Announce;
- an uncaught execution exception never produces an Announce;
- a system-level model failure bypasses Supervisor and finalization synthesis;
- Supervisor accepts a result and commits more work;
- Supervisor accepts a result with no more executable Capability work;
- Supervisor continues the exact active delegation;
- continuation feedback reaches the next briefing without changing the task;
- replacing an incomplete task preserves its evidence without marking success;
- acceptance followed by a natural question dispatches no remaining task;
- multiple control calls apply no root effects before validation;
- a control proposal ends the invocation without another model round;
- replay of a committed proposal does not repeat acceptance or dispatch;
- Supervisor naturally returns without accepting incomplete work;
- private Capability and Supervisor messages remain outside main history.

## Non-goals

- Redesigning interruption, Review, cancellation, or cross-run recovery.
- Implementing the complete Run Finalizer in the same change.
- Adding completion or progress flags to Announce.
- Giving Supervisor access to the full Capability transcript.
- Letting root infer semantic task completion.
- Treating internal guard diagnostics as user-facing result data.

## Acceptance criteria

- Supervisor cannot observe a subagent stop reason through Announce or Boundary
  input.
- Every normal post-execution Boundary has typed result evidence.
- Exceptions are never disguised as Announces.
- Root validates commands but does not independently judge result completeness.
- The command protocol covers every valid combination of current-result
  acceptance and remaining work without separate goal-done,
  user-input-required, and unavailable command families.
- The main conversation contains handed-off typed execution evidence and the
  final Supervisor reply, but no raw Supervisor or private Capability transcript.
- Static context audit, unit tests, and targeted real-model evals pass.
