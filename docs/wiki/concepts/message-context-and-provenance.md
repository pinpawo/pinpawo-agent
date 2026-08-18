---
title: Message Context And Provenance
page_type: concept
status: validated
updated: 2026-08-18
sources:
  - ../../../packages/pet-agent/src/agent/orchestrator/messageLanes.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/delegationBriefing.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/runtime/activeDelegationTransition.ts
  - https://github.com/pinpawo/pinpawo-agent/pull/475
  - https://github.com/pinpawo/pinpawo-agent/pull/481
related:
  - context-injection-map.md
  - ../interruption-and-delegation-continuation.md
  - decision-node-ownership.md
---

# Message Context And Provenance

## Evidence status

Validated for message **provenance and identity**. Everything this page once
said about context assembly — Goal Creation, `runUserGoal`, the
`Gₜ = GoalCreation(...)` flow, completeness-first Capability context, and the
PR #632 implementation gap — has been superseded and removed.

> **Context assembly is owned by [Context injection map](context-injection-map.md).**
> Goal Creation and `runUserGoal` no longer exist in code; goal authorship moved
> into Entry Answer via `plan_request(goal)` (PR #666), and the Planner
> transcript moved into the root `orchestrator` lane (PR #664).

## Identity is metadata, not prose

Current protocol identity comes from lane, run ID, delegation ID, message ID, and
handoff provenance. Runtime code does not infer message roles from prefixes such
as `<delegation_briefing>` or `【委派简报】`.

This was progressively established by PRs #363, #366, #398, and #404. A new
prompt or wiki convention must not reintroduce content-shape routing.

PR #467 extends the same rule to terminal meaning: provenance answers “where did
this result come from?”, while typed outcome state answers “what does this
result establish?”. Neither question is inferred from message prose.

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
