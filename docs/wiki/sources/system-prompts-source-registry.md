---
title: System Prompt Source Registry
page_type: source
status: draft
updated: 2026-07-20
sources:
  - ../../PET_AGENT_DECISION_SYSTEM_PROMPT_DESIGN.md
  - ../../../packages/pet-agent/src/agent/orchestrator/prompts/templates/entryDecision.prompt.ts
related:
  - ../overview.md
  - ../investigations/entry-decision-state-query-routing.md
---

# System Prompt Source Registry

## Current implementation

These sources describe what currently runs and have the highest authority for
behavioral claims:

- [`prompts/templates/sharedPrefix.prompt.ts`](../../../packages/pet-agent/src/agent/orchestrator/prompts/templates/sharedPrefix.prompt.ts)
- [`prompts/templates/entryDecision.prompt.ts`](../../../packages/pet-agent/src/agent/orchestrator/prompts/templates/entryDecision.prompt.ts)
- [`prompts/templates/capabilityPlanner.prompt.ts`](../../../packages/pet-agent/src/agent/orchestrator/prompts/templates/capabilityPlanner.prompt.ts)
- [`prompts/templates/capabilityDecision.prompt.ts`](../../../packages/pet-agent/src/agent/orchestrator/prompts/templates/capabilityDecision.prompt.ts)
- [`prompts/templates/outcomeDecision.prompt.ts`](../../../packages/pet-agent/src/agent/orchestrator/prompts/templates/outcomeDecision.prompt.ts)
- [`prompts/templates/answer.prompt.ts`](../../../packages/pet-agent/src/agent/orchestrator/prompts/templates/answer.prompt.ts)
- [`schemas.ts`](../../../packages/pet-agent/src/agent/orchestrator/schemas.ts)
- [`runtime/decisions/orchestrationDecision.ts`](../../../packages/pet-agent/src/agent/orchestrator/runtime/decisions/orchestrationDecision.ts)
- [`runtime/nodes/answer.ts`](../../../packages/pet-agent/src/agent/orchestrator/runtime/nodes/answer.ts)
- [`messageLanes.ts`](../../../packages/pet-agent/src/agent/orchestrator/messageLanes.ts)
- [`orchestrator.test.ts`](../../../packages/pet-agent/src/agent/orchestrator/orchestrator.test.ts)
- [`entry-decision-basics.ts`](../../../packages/pet-agent/evals/datasets/entry-decision-basics.ts)

## Current and pinned design sources

- [Decision system prompt design](../../PET_AGENT_DECISION_SYSTEM_PROMPT_DESIGN.md)
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

## External method source

- [Karpathy LLM Wiki](karpathy-llm-wiki.md)

## Trace observation

LangSmith run `019f7c5b-4bb0-7456-bd2d-f8d05c1f48b5` is registered only by
redacted ID. It observed an `entryDecision` invocation choosing `answer` for the
question “你把改动直接commit了？” even though the conversation contained no
explicit commit evidence. The private raw payload is not copied into the wiki.
