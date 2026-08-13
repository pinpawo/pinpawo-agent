---
title: Message Context And Provenance
page_type: concept
status: draft
updated: 2026-08-13
sources:
  - ../../ENTRY_GOAL_CREATION_REFACTOR_DESIGN.md
  - ../../PET_AGENT_ANNOUNCE_JUDGMENT_REFACTOR.md
  - ../../ORCHESTRATOR_TERMINAL_SEMANTICS_DRAFT.md
  - ../../PET_AGENT_API_CAPABILITY_TOOLKIT.md
  - ../../capability-artifact-pipeline/index.md
  - ../../DYNAMIC_CONTEXT_GOVERNANCE_DESIGN.md
  - ../../../packages/pet-agent/src/agent/orchestrator/delegationBriefing.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/messageLanes.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/capabilityPlanner/agent.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/runtime/decisions/orchestrationDecision.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/runtime/activeDelegationTransition.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/runtime/nodes/capability.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/runtime/nodes/capabilityPlanner.ts
  - https://github.com/pinpawo/pinpawo-agent/pull/475
  - https://github.com/pinpawo/pinpawo-agent/pull/481
  - https://github.com/pinpawo/pinpawo-agent/pull/632
related:
  - ../capability-toolkit-architecture.md
  - ../interruption-and-delegation-continuation.md
  - orchestrator-practical-reasoning.md
  - decision-node-ownership.md
  - dynamic-context-governance.md
  - ../decisions/delegation-completion-acknowledgement.md
---

# Message Context And Provenance

## Evidence status

The lane, announce, and handoff contracts are validated current behavior. The
Goal Creation and persistent private Planner flow described below is the
implementation candidate in draft PR
[#632](https://github.com/pinpawo/pinpawo-agent/pull/632). The page is therefore
`draft` until that refactor is accepted and its complete Wiki topic is ingested.

## State and message views

The physical `messages` channel contains both the main conversation and private
delegation lanes. `runUserGoal` is separate root state; Goal Creation does not
append its generated text to `messages`. Consumers construct different views
from state and message provenance:

- Goal Creation reads canonical main conversation, compaction summaries, and
  bounded runtime facts, then stores one text `runUserGoal`;
- the private Planner receives that goal as its current input and retains its
  own trace-scoped transcript;
- a selected Capability subagent sees lane-free canonical main context plus its
  own lane/run/delegation transcript;
- Answer reads canonical main context, `runUserGoal`, and bounded terminal facts;
- accepted results cross task boundaries only through a handoff copy.

These views are implemented by the
[Goal Creation runner](../../../packages/pet-agent/src/agent/orchestrator/runtime/decisions/orchestrationDecision.ts),
[lane selectors](../../../packages/pet-agent/src/agent/orchestrator/messageLanes.ts),
and [Capability node](../../../packages/pet-agent/src/agent/orchestrator/runtime/nodes/capability.ts).

“Full main context” means the canonical lane-free conversation currently owned
by the root graph, subject to the root compaction contract. It includes accepted
handoff copies. It does not include another Capability's private model/tool
transcript or an unaccepted announce.

## Goal-to-delegation information flow

For one task boundary, use these symbols:

- `Mₜ`: canonical main messages, including accepted earlier handoffs;
- `Gₜ`: the current `runUserGoal` generated from `Mₜ` plus bounded facts;
- `Bₜ`: the delegation briefing deterministically rendered from the Planner's
  current task;
- `Lₜ`: the selected delegation's private transcript;
- `Xₜ`: the selected Capability subagent's execution context.

The candidate flow is:

```text
Gₜ = GoalCreation(Mₜ, compaction summaries, runtime facts)
taskₜ = Planner(Gₜ, private Planner state)
Bₜ = render(taskₜ)
Xₜ(current) = Mₜ + Bₜ + Lₜ
Mₜ₊₁ = Mₜ + accepted_handoff(resultₜ)
```

**Fact (draft PR #632).** `Gₜ` travels through root state and Planner input, not
through canonical main messages. In the current PR implementation, Capability
execution requires `runUserGoal` to exist but does not yet project it into
`Xₜ`; initial delegation materialization also leaves `essentialContext` empty. See the
[Planner materializer](../../../packages/pet-agent/src/agent/orchestrator/runtime/nodes/capabilityPlanner.ts).

## Completeness-first Capability context

**Decision.** Preserve canonical main messages at the Capability boundary.
Goal Creation is a lossy semantic projection and must not replace the accepted
evidence from which it was derived. A prior handoff may contain file paths,
changes, observations, decisions, or result details that neither a compact goal
nor a later task briefing can reconstruct.

The intended execution context is therefore:

```text
Xₜ(target) = Mₜ + Gₜ + Bₜ + Lₜ
```

Each component has a distinct role:

| Component | Role |
|---|---|
| `Mₜ` | complete canonical evidence and cross-delegation shared memory |
| `Gₜ` | stable global objective, constraints, and attention index over `Mₜ` |
| `Bₜ` | the current Planner-selected execution boundary |
| `Lₜ` | private working memory needed to continue the same delegation |

`Gₜ` is useful even though it mostly repeats facts in `Mₜ`: it identifies which
facts define the current objective. `Bₜ` narrows that objective to one executable
task. Neither summary is permission to discard the source evidence.

This makes main conversation a shared blackboard across Capabilities. A result
becomes cross-task knowledge only after the boundary Planner accepts its
announce and the runtime
[copies it into main](../../../packages/pet-agent/src/agent/orchestrator/messageLanes.ts)
with handoff provenance. Raw executor transcript remains private.

## Information completeness and redundancy

**Inference.** No numeric Shannon entropy is claimed without a representative
message distribution. Conditional information still explains the boundary:

```text
H(Gₜ | Mₜ)             is low: Goal Creation derives the goal from main context.
H(Bₜ | Mₜ, Gₜ)         is material: private Planner deliberation selects the task.
H(Mₜ | Gₜ, Bₜ)         is material: detailed prior evidence cannot be reconstructed.
H(Lₜ | Mₜ, Gₜ, Bₜ)     is material: continuation state exists only in the lane.
```

Consequently, removing `Mₜ` is information loss, not ordinary prompt
deduplication. Repeated append-only prefixes may also benefit from provider
caching. Cache behavior is an optimization rather than a correctness premise:
Capability-specific governing prompts can change the reusable prefix, and
cached input still consumes context capacity.

Remove repetition only when its conditional information is demonstrably near
zero and the authoritative source remains present. Examples include rendering
the same goal both as a dedicated goal block and generic `essentialContext`, or
synthesizing an extra task copy beyond the already-preserved canonical plan
message and briefing. Do not filter canonical main at the Capability boundary
merely to remove repetition. Do not remove accepted handoffs, explicit evidence,
or lane history merely because Goal Creation summarized them.

The private Planner transcript is not part of `Xₜ`. Root receives only its
terminal action and plan tasks. Attachments, artifacts, and other source
material that cannot be represented faithfully as text remain evidence and
must reach the Capability through canonical messages or explicit references.

## Directional message roles

- **Delegation briefing** points downward. It is a deterministic projection of
  the current `DelegationSpec` into the selected private lane.
- **User Goal** is Goal Creation's text projection of the current objective and
  necessary confirmed background. It is durable root state, not a main message
  or a Planner-private inference.
- **Announce** points upward. The subagent explicitly identifies its deliverable
  through `announceMessageId`.
- **Handoff** is an announce accepted by the boundary Planner and copied into
  main with provenance, after which the private lane can be cleared. It
  identifies accepted evidence and its source; its provenance alone does not
  encode terminal meaning.
- **Completion acknowledgement** is the answer node's stable close when the
  accepted outcome establishes `goal_done`; it is not a second copy of the task
  deliverable.
- **Return-control close** communicates accepted progress and missing user input
  when the outcome is `user_input_required`; it is not a completion claim.
- **Planner entry input** carries `runUserGoal`, the immutable Capability
  workspace, and a fresh trace input identity into the private Planner.
- **Planner boundary input** carries the same goal, current task, candidate
  announce, and remaining unstarted plan. Planner acceptance creates the
  handoff; the candidate announce is not accepted merely because it exists.

## Identity is metadata, not prose

Current protocol identity comes from lane, run ID, delegation ID, message ID, and
handoff provenance. Runtime code does not infer message roles from prefixes such
as `<delegation_briefing>` or `【委派简报】`.

This was progressively established by PRs #363, #366, #398, and #404. A new
prompt or wiki convention must not reintroduce content-shape routing.

PR #467 extends the same rule to terminal meaning: provenance answers “where did
this result come from?”, while typed outcome state answers “what does this
result establish?”. Neither question is inferred from message prose.

## Canonical goal context

Goal Creation receives one governing system contract, a synthetic facts-only
runtime message, and canonical main human/assistant messages in their original
roles and order. Root compaction summaries are projected explicitly. Accepted
results reach it through handoff; unfinished private execution transcripts do
not enter this view.

This boundary prevents old executor output from outranking a newer user request
and keeps private execution transcripts out of run-entry intent resolution.

Goal Creation stores its complete bounded text as `runUserGoal` and dispatches
the Planner without appending a generated assistant message to main. The
Planner receives the goal in its own input and keeps exploration private. At
later task boundaries, the same goal remains stable while the candidate
announce, current task, and future plan change.

## Interruption preserves evidence without accepting it

**Decision (PRs #475 and #481).** An interrupted or otherwise incomplete
delegation retains its exact private lane, including prior model/tool messages,
the human-interrupt cancellation result, and guard-stop evidence. It creates no
announce or handoff and therefore contributes no accepted result to canonical
main context.

The next request makes the boundary explicit:

- ordinary input uses `supersede_active`, clears the active pointer, and enters
  with canonical main context while the old lane remains historical checkpoint
  evidence;
- `resume_active` reuses the same delegation and lane transcript under the
  stable task trace so the selected Capability can continue with its original
  provenance.

A resumed root invocation may have a new `runId`; `traceId` remains the stable
task identity, while the retained active delegation keeps the transcript
identity needed to select its existing lane messages.

This is why “retain the lane” does not pollute a fresh turn and why “interrupted”
must not be modeled as a completed handoff. See
[Interruption and delegation continuation](../interruption-and-delegation-continuation.md).

## Implementation gap

PR #632 currently implements `Xₜ(current) = Mₜ + Bₜ + Lₜ`. The agreed target is
to add exactly one explicit `Gₜ` projection while retaining `Mₜ`. The goal must
remain task data rather than being elevated into stable Capability/Toolkit
instructions, and it must not be duplicated again as generic essential context.

Verification should cover cross-delegation continuity (for example, a prior
handoff's changed-file list), corrected user constraints, long accepted results,
and interrupted delegation continuation. The implementation must preserve the
existing exclusion of other private lanes and Planner-private transcript.
