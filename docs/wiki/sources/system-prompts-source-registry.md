---
title: System Prompt Source Registry
page_type: source
status: draft
updated: 2026-07-26
sources:
  - ../../PET_AGENT_DECISION_SYSTEM_PROMPT_DESIGN.md
  - ../../CAPABILITY_PLANNER_TASK_HORIZON_DRAFT.md
  - ../../ORCHESTRATOR_TERMINAL_SEMANTICS_DRAFT.md
  - ../../../packages/pet-agent/src/agent/orchestrator/prompts/templates/entryDecision.prompt.ts
  - https://github.com/pinpawo/pinpawo-agent/issues/415
  - https://github.com/pinpawo/pinpawo-agent/issues/416
  - https://github.com/pinpawo/pinpawo-agent/issues/417
  - https://github.com/pinpawo/pinpawo-agent/issues/418
  - https://github.com/pinpawo/pinpawo-agent/issues/435
related:
  - ../overview.md
  - ../decisions/capability-planner-task-boundaries.md
  - ../decisions/delegation-completion-acknowledgement.md
  - ../investigations/entry-decision-state-query-routing.md
  - model-prompting-and-harness-references.md
---

# System Prompt Source Registry

## Current implementation

These sources describe what currently runs and have the highest authority for
behavioral claims:

CapabilityPlanner claims added on 2026-07-26 describe the implementation merged
in [PR #461](https://github.com/pinpawo/pinpawo-agent/pull/461) and checked
against the resulting `main`. CapabilityDecision claims updated on 2026-07-26
describe the current working implementation and its GLM-5.2 `24/24` profile;
the eventual implementation PR remains part of the source trail rather than
being named before publication. Terminal-semantics claims describe the
implementation and paired GLM-5.2 validation published for review in
[PR #467](https://github.com/pinpawo/pinpawo-agent/pull/467); until merge, that
PR and its branch are the current implementation source for those claims.

- [`prompts/templates/sharedPrefix.prompt.ts`](../../../packages/pet-agent/src/agent/orchestrator/prompts/templates/sharedPrefix.prompt.ts)
- [`prompts/templates/entryDecision.prompt.ts`](../../../packages/pet-agent/src/agent/orchestrator/prompts/templates/entryDecision.prompt.ts)
- [`prompts/templates/capabilityPlanner.prompt.ts`](../../../packages/pet-agent/src/agent/orchestrator/prompts/templates/capabilityPlanner.prompt.ts)
- [`prompts/templates/capabilityDecision.prompt.ts`](../../../packages/pet-agent/src/agent/orchestrator/prompts/templates/capabilityDecision.prompt.ts)
- [`prompts/templates/outcomeDecision.prompt.ts`](../../../packages/pet-agent/src/agent/orchestrator/prompts/templates/outcomeDecision.prompt.ts)
- [`prompts/templates/answer.prompt.ts`](../../../packages/pet-agent/src/agent/orchestrator/prompts/templates/answer.prompt.ts)
- [`schemas.ts`](../../../packages/pet-agent/src/agent/orchestrator/schemas.ts)
- [`state.ts`](../../../packages/pet-agent/src/agent/orchestrator/state.ts)
- [`runtime/decisions/orchestrationDecision.ts`](../../../packages/pet-agent/src/agent/orchestrator/runtime/decisions/orchestrationDecision.ts)
- [`runtime/nodes/answer.ts`](../../../packages/pet-agent/src/agent/orchestrator/runtime/nodes/answer.ts)
- [`messageLanes.ts`](../../../packages/pet-agent/src/agent/orchestrator/messageLanes.ts)
- [`orchestrator.test.ts`](../../../packages/pet-agent/src/agent/orchestrator/orchestrator.test.ts)
- [`entry-decision-basics.ts`](../../../packages/pet-agent/evals/datasets/entry-decision-basics.ts)
- [`capability-decision-basics.ts`](../../../packages/pet-agent/evals/datasets/capability-decision-basics.ts)
- [`capability-planning-basics.ts`](../../../packages/pet-agent/evals/datasets/capability-planning-basics.ts)
- [`capability-planning-evaluation.ts`](../../../packages/pet-agent/evals/capability-planning-evaluation.ts)
- [`capability-planning-evaluation.test.ts`](../../../packages/pet-agent/evals/capability-planning-evaluation.test.ts)
- [`answer-behavior-basics.ts`](../../../packages/pet-agent/evals/datasets/answer-behavior-basics.ts)
- [`outcome-decision-basics.ts`](../../../packages/pet-agent/evals/datasets/outcome-decision-basics.ts)
- [`decision-eval-scenarios.ts`](../../../packages/pet-agent/evals/decision-eval-scenarios.ts)
- [`answer-eval-scenarios.ts`](../../../packages/pet-agent/evals/answer-eval-scenarios.ts)
- [`prompt-goal-evaluator.ts`](../../../packages/pet-agent/evals/prompt-goal-evaluator.ts)
- [`prompt-eval-report.ts`](../../../packages/pet-agent/evals/prompt-eval-report.ts)
- [`run-decision-stability.eval.ts`](../../../packages/pet-agent/evals/scripts/run-decision-stability.eval.ts)
- [`run-langfuse-capability-decision.eval.ts`](../../../packages/pet-agent/evals/scripts/run-langfuse-capability-decision.eval.ts)

## Current and pinned design sources

- [Decision system prompt design](../../PET_AGENT_DECISION_SYSTEM_PROMPT_DESIGN.md)
- [CapabilityPlanner task-horizon design](../../CAPABILITY_PLANNER_TASK_HORIZON_DRAFT.md)
- [Orchestrator terminal-semantics validation](../../ORCHESTRATOR_TERMINAL_SEMANTICS_DRAFT.md)
- [Decision shared prefix](../../PET_AGENT_ORCHESTRATOR_DECISION_PROMPT_PREFIX.md)
- [Decision node ownership audit](../../PET_AGENT_DECISION_NODE_OWNERSHIP_AUDIT.md)
- [Delegation state and task routing](../../PET_AGENT_DELEGATION_STATE_AND_TASK_ROUTING.md)
- [Announce judgment and handoff](../../PET_AGENT_ANNOUNCE_JUDGMENT_REFACTOR.md)
- [Capability runtime](../../PET_AGENT_CAPABILITY_RUNTIME_DESIGN.md)
- [Artifact prompt integration](../../capability-artifact-pipeline/prompt-integration.md)
- [Context governance](../../CONTEXT_GOVERNANCE_REFACTOR.md)

## Historical decision trail

- [PR #338 — delegation handoff answer flow](https://github.com/pinpawo/pinpawo-agent/pull/338)
- [PR #345 — static decision prompt contract](https://github.com/pinpawo/pinpawo-agent/pull/345)
- [Issue #349 — capability-aware planning](https://github.com/pinpawo/pinpawo-agent/issues/349)
- [PR #351 — planner graph](https://github.com/pinpawo/pinpawo-agent/pull/351)
- [PR #352 — planner contract and decision prompts](https://github.com/pinpawo/pinpawo-agent/pull/352)
- [PR #363 — deterministic delegation briefing](https://github.com/pinpawo/pinpawo-agent/pull/363)
- [PR #366 — briefing/handoff boundary alignment](https://github.com/pinpawo/pinpawo-agent/pull/366)
- [PR #370 — canonical entry messages](https://github.com/pinpawo/pinpawo-agent/pull/370)
- [PR #372 — remove recent-announce recall](https://github.com/pinpawo/pinpawo-agent/pull/372)
- [PR #398 — context boundary isolation](https://github.com/pinpawo/pinpawo-agent/pull/398)
- [PR #404 — message provenance finalization](https://github.com/pinpawo/pinpawo-agent/pull/404)

## Completed V1 implementation work

- [Issue #416 — entryDecision evidence/execution boundary](https://github.com/pinpawo/pinpawo-agent/issues/416)
- [Issue #417 — positive-first authoring refactor V1](https://github.com/pinpawo/pinpawo-agent/issues/417)
- [Issue #415 — Prompt Contract Map](https://github.com/pinpawo/pinpawo-agent/issues/415)
- [Issue #418 — system prompt evolution umbrella](https://github.com/pinpawo/pinpawo-agent/issues/418)

## Active validation work

- [Issue #435 — real-model prompt contract validation](https://github.com/pinpawo/pinpawo-agent/issues/435)
- [PR #461 — capabilityPlanner task-boundary refinement](https://github.com/pinpawo/pinpawo-agent/pull/461)
- [PR #467 — orchestrator terminal outcome semantics](https://github.com/pinpawo/pinpawo-agent/pull/467)

## External method and comparison sources

- [Karpathy LLM Wiki](karpathy-llm-wiki.md)
- [Current model prompting and agent harness references](model-prompting-and-harness-references.md)

## Trace observation

LangSmith run `019f7c5b-4bb0-7456-bd2d-f8d05c1f48b5` is registered only by
redacted ID. It observed an `entryDecision` invocation choosing `answer` for the
question “你把改动直接commit了？” even though the conversation contained no
explicit commit evidence. The private raw payload is not copied into the wiki.
