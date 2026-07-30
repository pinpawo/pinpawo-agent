---
title: System Prompt Source Registry
page_type: source
status: validated
updated: 2026-07-31
sources:
  - ../../PET_AGENT_DECISION_SYSTEM_PROMPT_DESIGN.md
  - ../../ORCHESTRATOR_TERMINAL_SEMANTICS_DRAFT.md
  - ../../PET_AGENT_API_CAPABILITY_TOOLKIT.md
  - ../../../packages/pet-agent/src/agent/orchestrator/capabilityPlannerAgent.ts
  - https://github.com/pinpawo/pinpawo-agent/issues/490
  - https://github.com/pinpawo/pinpawo-agent/pull/492
  - https://github.com/pinpawo/pinpawo-agent/pull/515
related:
  - ../overview.md
  - ../capability-toolkit-architecture.md
  - ../decisions/capability-planner-task-boundaries.md
  - ../decisions/delegation-completion-acknowledgement.md
  - ../questions/system-prompts-open-questions.md
  - model-prompting-and-harness-references.md
---

# System Prompt Source Registry

## Authority order

For current behavior:

1. merged implementation and tests;
2. accepted current design sources and merged PRs;
3. eval observations for their exact model, harness, and cases;
4. historical issues, PRs, and superseded designs as evolution evidence.

Historical sources do not override current code merely because they contain more
detail.

## Current implementation

### Prompt contracts

- [`sharedPrefix.prompt.ts`](../../../packages/pet-agent/src/agent/orchestrator/prompts/templates/sharedPrefix.prompt.ts)
- [`entryDecision.prompt.ts`](../../../packages/pet-agent/src/agent/orchestrator/prompts/templates/entryDecision.prompt.ts)
- [`capabilityPlannerAgent.prompt.ts`](../../../packages/pet-agent/src/agent/orchestrator/prompts/templates/capabilityPlannerAgent.prompt.ts)
- [`outcomeDecision.prompt.ts`](../../../packages/pet-agent/src/agent/orchestrator/prompts/templates/outcomeDecision.prompt.ts)
- [`answer.prompt.ts`](../../../packages/pet-agent/src/agent/orchestrator/prompts/templates/answer.prompt.ts)

### Planner harness and workspace

- [`capabilityPlannerAgent.ts`](../../../packages/pet-agent/src/agent/orchestrator/capabilityPlannerAgent.ts)
- [`capabilityPlannerRunner.ts`](../../../packages/pet-agent/src/agent/orchestrator/capabilityPlannerRunner.ts)
- [`capabilityPlannerFileExplorer.ts`](../../../packages/pet-agent/src/agent/orchestrator/capabilityPlannerFileExplorer.ts)
- [`capabilityPlannerWorkspaceReader.ts`](../../../packages/pet-agent/src/agent/orchestrator/capabilityPlannerWorkspaceReader.ts)
- [`capabilityDocumentWorkspace.ts`](../../../packages/pet-agent/src/agent/orchestrator/capabilityDocumentWorkspace.ts)
- [`runtime/nodes/capabilityPlanner.ts`](../../../packages/pet-agent/src/agent/orchestrator/runtime/nodes/capabilityPlanner.ts)

### Graph, state, and execution

- [`schemas.ts`](../../../packages/pet-agent/src/agent/orchestrator/schemas.ts)
- [`state.ts`](../../../packages/pet-agent/src/agent/orchestrator/state.ts)
- [`runtime/graph.ts`](../../../packages/pet-agent/src/agent/orchestrator/runtime/graph.ts)
- [`runtime/decisions/orchestrationDecision.ts`](../../../packages/pet-agent/src/agent/orchestrator/runtime/decisions/orchestrationDecision.ts)
- [`runtime/nodes/capability.ts`](../../../packages/pet-agent/src/agent/orchestrator/runtime/nodes/capability.ts)
- [`runtime/nodes/answer.ts`](../../../packages/pet-agent/src/agent/orchestrator/runtime/nodes/answer.ts)
- [`messageLanes.ts`](../../../packages/pet-agent/src/agent/orchestrator/messageLanes.ts)

### Verification

- [`capabilityPlannerAgent.test.ts`](../../../packages/pet-agent/src/agent/orchestrator/capabilityPlannerAgent.test.ts)
- [`capabilityPlannerFileExplorer.test.ts`](../../../packages/pet-agent/src/agent/orchestrator/capabilityPlannerFileExplorer.test.ts)
- [`orchestrator.test.ts`](../../../packages/pet-agent/src/agent/orchestrator/orchestrator.test.ts)
- [`entry-decision-basics.ts`](../../../packages/pet-agent/evals/datasets/entry-decision-basics.ts)
- [`capability-planning-basics.ts`](../../../packages/pet-agent/evals/datasets/capability-planning-basics.ts)
- [`capability-planning-evaluation.ts`](../../../packages/pet-agent/evals/capability-planning-evaluation.ts)
- [`outcome-decision-basics.ts`](../../../packages/pet-agent/evals/datasets/outcome-decision-basics.ts)
- [`decision-contract-scorers.ts`](../../../packages/pet-agent/evals/decision-contract-scorers.ts)
- [`answer-behavior-basics.ts`](../../../packages/pet-agent/evals/datasets/answer-behavior-basics.ts)
- [`run-lifecycle-composition.eval.ts`](../../../packages/pet-agent/evals/scripts/run-lifecycle-composition.eval.ts)

## Current design sources

- [Decision system prompt design](../../PET_AGENT_DECISION_SYSTEM_PROMPT_DESIGN.md)
- [Orchestrator terminal semantics](../../ORCHESTRATOR_TERMINAL_SEMANTICS_DRAFT.md)
- [Orchestrator lifecycle composition eval](../../ORCHESTRATOR_LIFECYCLE_COMPOSITION_EVAL.md)
- [Decision shared prefix](../../PET_AGENT_ORCHESTRATOR_DECISION_PROMPT_PREFIX.md)
- [Announce judgment and handoff](../../PET_AGENT_ANNOUNCE_JUDGMENT_REFACTOR.md)
- [Capability / Toolkit V2 contract](../../PET_AGENT_API_CAPABILITY_TOOLKIT.md)
- [Capability / Toolkit composition](../../PET_AGENT_TOOLKIT_COMPOSITION_DESIGN.md)
- [Capability artifact pipeline](../../capability-artifact-pipeline/index.md)
- [Context governance](../../CONTEXT_GOVERNANCE_REFACTOR.md)

## Accepted current change trail

- [Issue #473 — Capability Planner document exploration](https://github.com/pinpawo/pinpawo-agent/issues/473)
- [PR #474 — Capability Document Workspace foundation](https://github.com/pinpawo/pinpawo-agent/pull/474)
- [PR #477 — private Planner file exploration](https://github.com/pinpawo/pinpawo-agent/pull/477)
- [PR #480 — Capability Planner Agent loop](https://github.com/pinpawo/pinpawo-agent/pull/480)
- [PR #483 — graph cutover](https://github.com/pinpawo/pinpawo-agent/pull/483)
- [Issue #490 — task-boundary and entry contract consolidation](https://github.com/pinpawo/pinpawo-agent/issues/490)
- [PR #492 — unified Planner task and Capability ownership](https://github.com/pinpawo/pinpawo-agent/pull/492)
- [PR #515 — standard Agent runtime, structured result handoff, and simplified Planner prompts](https://github.com/pinpawo/pinpawo-agent/pull/515)

## Historical evolution

The following sources explain how the current architecture evolved. Their node
topology and output contracts are not current guidance:

- [PR #338 — delegation handoff answer flow](https://github.com/pinpawo/pinpawo-agent/pull/338)
- [PR #345 — static decision prompt contract](https://github.com/pinpawo/pinpawo-agent/pull/345)
- [Issue #349 — capability-aware planning](https://github.com/pinpawo/pinpawo-agent/issues/349)
- [PR #351 — planner graph](https://github.com/pinpawo/pinpawo-agent/pull/351)
- [PR #352 — planner and decision prompts](https://github.com/pinpawo/pinpawo-agent/pull/352)
- [PR #363 — deterministic delegation briefing](https://github.com/pinpawo/pinpawo-agent/pull/363)
- [PR #366 — briefing/handoff alignment](https://github.com/pinpawo/pinpawo-agent/pull/366)
- [PR #370 — canonical entry messages](https://github.com/pinpawo/pinpawo-agent/pull/370)
- [PR #398 — context isolation](https://github.com/pinpawo/pinpawo-agent/pull/398)
- [PR #404 — message provenance](https://github.com/pinpawo/pinpawo-agent/pull/404)
- [PR #461 — result-bounded future-plan refinement](https://github.com/pinpawo/pinpawo-agent/pull/461)
- [PR #467 — terminal outcome semantics](https://github.com/pinpawo/pinpawo-agent/pull/467)
- [PR #470 — Capability / Toolkit V2](https://github.com/pinpawo/pinpawo-agent/pull/470)

## External method and comparison sources

- [Karpathy LLM Wiki](karpathy-llm-wiki.md)
- [Current model prompting and agent harness references](model-prompting-and-harness-references.md)

## Bounded trace observation

LangSmith run `019f7c5b-4bb0-7456-bd2d-f8d05c1f48b5` remains registered only by
redacted ID. It observed an entry decision treating conversational intent as
sufficient evidence for a current-state answer. It is historical evidence for
the entry evidence-freshness question, not evidence for the removed planner
topology.
