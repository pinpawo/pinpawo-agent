---
title: Message Context And Provenance
page_type: concept
status: validated
updated: 2026-07-28
sources:
  - ../../PET_AGENT_ANNOUNCE_JUDGMENT_REFACTOR.md
  - ../../ORCHESTRATOR_TERMINAL_SEMANTICS_DRAFT.md
  - ../../PET_AGENT_API_CAPABILITY_TOOLKIT.md
  - ../../capability-artifact-pipeline/prompt-integration.md
  - ../../../packages/pet-agent/src/agent/orchestrator/messageLanes.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/runtime/decisions/orchestrationDecision.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/runtime/activeDelegationTransition.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/runtime/nodes/capability.ts
  - https://github.com/pinpawo/pinpawo-agent/pull/475
  - https://github.com/pinpawo/pinpawo-agent/pull/481
related:
  - ../capability-toolkit-architecture.md
  - ../interruption-and-delegation-continuation.md
  - orchestrator-practical-reasoning.md
  - decision-node-ownership.md
  - ../decisions/delegation-completion-acknowledgement.md
---

# Message Context And Provenance

## Main and delegation views

The physical `messages` channel contains both the main conversation and private
delegation lanes. Consumers construct different views from metadata:

- decision and answer nodes use the lane-free canonical main conversation;
- a selected subagent sees main context plus its own lane/run/delegation transcript;
- accepted results cross task boundaries only through a handoff copy.

## Directional message roles

- **Delegation briefing** points downward. It is a deterministic projection of
  the current `DelegationSpec` into the selected private lane.
- **Announce** points upward. The subagent explicitly identifies its deliverable
  through `announceMessageId`.
- **Handoff** is the accepted announce copied into main with provenance, after
  which the private lane can be cleared. It identifies accepted evidence and its
  source; it does not assert task or goal completion.
- **Completion acknowledgement** is the answer node's stable close when the
  accepted outcome establishes `goal_done`; it is not a second copy of the task
  deliverable.
- **Return-control close** communicates accepted progress and missing user input
  when the outcome is `user_input_required`; it is not a completion claim.

## Identity is metadata, not prose

Current protocol identity comes from lane, run ID, delegation ID, message ID, and
handoff provenance. Runtime code does not infer message roles from prefixes such
as `<delegation_briefing>` or `【委派简报】`.

This was progressively established by PRs #363, #366, #398, and #404. A new
prompt or wiki convention must not reintroduce content-shape routing.

PR #467 extends the same rule to terminal meaning: provenance answers “where did
this result come from?”, while typed outcome state answers “what does this
result establish?”. Neither question is inferred from message prose.

## Canonical entry context

`entryDecision` receives one governing system contract, a synthetic facts-only
runtime message, and canonical main messages in their original roles and order.
It does not scan global recent announces or artifact inventories. Accepted
results reach it through handoff; unfinished delegation state belongs to
outcomeDecision.

This boundary prevents old executor output from outranking a newer user request
and keeps private execution transcripts out of run-entry intent resolution.

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
- `resume_active` reuses the same delegation, run, and lane so the selected
  capability can continue with its original provenance.

This is why “retain the lane” does not pollute a fresh turn and why “interrupted”
must not be modeled as a completed handoff. See
[Interruption and delegation continuation](../interruption-and-delegation-continuation.md).
