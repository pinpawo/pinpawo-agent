---
title: CapabilityPlanner Maintains Result-Bounded Future Work
page_type: decision
status: draft
updated: 2026-07-26
sources:
  - ../../CAPABILITY_PLANNER_TASK_HORIZON_DRAFT.md
  - ../../PET_AGENT_DECISION_SYSTEM_PROMPT_DESIGN.md
  - ../../PET_AGENT_DELEGATION_STATE_AND_TASK_ROUTING.md
  - ../../../packages/pet-agent/src/agent/orchestrator/prompts/templates/capabilityPlanner.prompt.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/runtime/decisions/orchestrationDecision.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/schemas.ts
  - ../../../packages/pet-agent/evals/datasets/capability-planning-basics.ts
  - ../../../packages/pet-agent/evals/capability-planning-evaluation.ts
  - https://github.com/pinpawo/pinpawo-agent/pull/461
related:
  - ../overview.md
  - ../concepts/decision-node-ownership.md
  - ../concepts/system-prompt-authoring-principles.md
  - ../questions/system-prompts-open-questions.md
---

# CapabilityPlanner Maintains Result-Bounded Future Work

## Status and scope

This decision has passed the fixed GLM-5.2 planner profile and is implemented in
[PR #461](https://github.com/pinpawo/pinpawo-agent/pull/461). The page remains
`draft` until that implementation is merged and checked against `main`.

The decision refines the existing `planner.execution-boundary` contract. It does
not add another orchestrator decision, move executor selection into the planner,
or make a fixed task decomposition part of the product contract.

## Decision

`capabilityPlanner` maintains the semantic state of the plan across execution
results.

- Completed task objectives and result summaries are immutable execution facts.
- `latest_handoff` is the complete newest result available at the current
  boundary.
- `remaining_plan` is the unstarted future tail. The planner may concretize,
  revise, preserve, reorder, or cancel it when facts change.
- `next_task` is the first task that the available results make executable now.
- The ordered position of `next_task` and `remaining_plan` expresses time;
  future-task labels such as `concrete` and `deferred` are not separate state.

The runtime preserves facts and maps the structured result into graph state. It
does not reconstruct, advance, or freeze the plan in code.

## Task boundary

A task continues while one kind of ability can work continuously toward one
useful returned result. Stages that the ability arranges internally remain
inside that task.

A new task boundary is justified when:

- later work cannot be decided until the current task returns its result;
- a different kind of ability must execute independently; or
- a separately useful acceptance result warrants returning control to the
  planner.

The number of verbs, implementation phases, or anticipated intermediate
artifacts does not determine task count. More than one decomposition may be
valid when each boundary is justified and the complete user goal remains
preserved.

## Entry and boundary planning

At `entry`, the planner starts from the complete user goal. It materializes the
first executable task and preserves later required purposes without inventing
details that depend on results that do not yet exist.

At `boundary`, the planner receives four distinct roles:

| Input | Role |
|---|---|
| Complete user goal and canonical conversation | Purpose and interpretation |
| `completed_tasks` | Read-only facts about work that has already happened |
| `latest_handoff` | The newest full result that may change future work |
| `remaining_plan` | Mutable, unstarted work after the completed boundary |

It uses those inputs to materialize the next task, revise the tail, cancel work
made obsolete by the result, or select `answer` when no autonomous work remains.
Already completed work remains visible as fact but cannot return to the future
plan.

## Ownership and enforcement

The planner owns:

- the current task objective;
- future task objectives, boundaries, and order;
- plan revision after completed results;
- `capability_intent` as a semantic description of the ability a task needs.

[`capabilityDecision`](../concepts/decision-node-ownership.md#vertical-decisions)
owns selection of a concrete executor. The capability registry informs the
planner about available ability types but does not turn `capability_intent` into
a registry identifier.

The model-visible schema owns the relationship among `result`, `next_task`, and
`remaining_plan`. Runtime validation enforces the nullable/empty combinations
and exact duplicate rejection. The graph mechanically maps `next_task` to the
pending task and `remaining_plan` to the future tail.

## Evaluation contract

Evaluation follows the existing objective-derived pattern:

- deterministic checks own the exact top-level `result` and schema validity;
- the goal evaluator judges the materialized task, current capability intent,
  justification of boundaries, preservation and order of future objectives,
  and semantic compatibility of future capability intents;
- executor identity is evaluated only by the capability-selection contract;
- task count, plan effect, rubber-stamp behavior, latency, tokens, and variants
  remain diagnostics unless a case objective explicitly requires them.

The planner stability profile contains six entry/boundary cases covering
creation, handoff-driven materialization, cancellation, preservation,
current/future separation, and result-dependent follow-up. The final GLM-5.2
profile achieved three evaluable passes for every case, `18/18` in total. One
judge timeout in the full run was replaced by a supplemental evaluable run; it
was not counted as subject-model success or failure.

Both the prompt-stability runner and the Langfuse LLM runner now use the shared
planner goal contract in
[`capability-planning-evaluation.ts`](../../../packages/pet-agent/evals/capability-planning-evaluation.ts).
A regression test verifies that the correct top-level `result` cannot pass when
the future plan loses the user's objective.

## Consequences

- Plan evolution remains a language-model judgment instead of a coded queue
  mutation policy.
- Completed execution history is stable even when later planning changes.
- Result-dependent work can retain its purpose without pretending that unknown
  details are already determined.
- The prompt can describe the planning problem directly without maintaining
  unused temporal labels.
- Cross-model validation remains follow-up evidence; the accepted GLM-5.2
  profile establishes the current single-model baseline.
