---
title: System Prompt Design Knowledge Map
page_type: overview
status: draft
updated: 2026-07-26
sources:
  - ../PET_AGENT_DECISION_SYSTEM_PROMPT_DESIGN.md
  - ../PET_AGENT_DELEGATION_STATE_AND_TASK_ROUTING.md
  - ../CAPABILITY_PLANNER_TASK_HORIZON_DRAFT.md
  - ../ORCHESTRATOR_TERMINAL_SEMANTICS_DRAFT.md
  - ../../packages/pet-agent/src/agent/orchestrator/prompts/templates/sharedPrefix.prompt.ts
  - https://github.com/pinpawo/pinpawo-agent/issues/418
related:
  - concepts/orchestrator-practical-reasoning.md
  - concepts/prompt-knowledge-layers.md
  - concepts/system-prompt-authoring-principles.md
  - concepts/decision-node-ownership.md
  - concepts/message-context-and-provenance.md
  - decisions/capability-planner-task-boundaries.md
  - decisions/delegation-completion-acknowledgement.md
  - investigations/entry-decision-state-query-routing.md
---

# System Prompt Design Knowledge Map

## Current synthesis

The orchestrator prompt system is not one prompt. It is a set of contracts that
sit on top of a deterministic graph and a provenance-aware message model.

```mermaid
flowchart LR
  U["User request + canonical main conversation"] --> E["entryDecision"]
  E -->|answer| A["answer"]
  E -->|direct_task| C["capabilityDecision"]
  E -->|needs_plan| P["capabilityPlanner"]
  P --> C
  C --> X["selected capability subagent"]
  C -->|unavailable| A
  X --> O["outcomeDecision"]
  O -->|continue| X
  O -->|task_done| P
  O -->|goal_done| A
  O -->|user_input_required| A
  X -->|announce| O
  O -->|accepted handoff| M["main conversation"]
  M --> A
```

Six relationships organize the current knowledge:

1. [The practical-reasoning philosophy](concepts/orchestrator-practical-reasoning.md)
   starts from the human problem of purpose, interpretation, situated knowledge,
   consequential action, distributed responsibility, time, and completion. It
   derives epistemic, causal, and normative boundaries only as a projection into
   the current architecture.
2. [Prompt knowledge layers](concepts/prompt-knowledge-layers.md) distinguish
   stable contracts, conditional provider protocol, injected facts, and code
   enforcement.
3. [System prompt authoring principles](concepts/system-prompt-authoring-principles.md)
   define positive-first behavior contracts, the valid scope of negative
   constraints, and when enforcement belongs to the harness.
4. [Decision node ownership](concepts/decision-node-ownership.md) keeps semantic
   judgments vertical: entry shape, plan boundary, executor choice, and outcome
   acceptance have different owners. The
   [CapabilityPlanner task-boundary decision](decisions/capability-planner-task-boundaries.md)
   defines how completed facts and returned results revise only the unstarted
   future plan.
5. [Message context and provenance](concepts/message-context-and-provenance.md)
   determines which messages each actor sees and how briefing, announce, and
   handoff identities are established.
6. [The answer close](decisions/delegation-completion-acknowledgement.md) keeps
   the fixed acknowledgement for genuine goal completion and returns control
   truthfully when an accepted result still requires user input.

## Prompt Contract Map

This table is the traceability map. One row represents one stable behavior
contract, not one sentence in a prompt. The map intentionally has only five
relations: contract, owner, design source, implementation, and verification.

| Contract | Owner | Design source | Implementation | Verification |
|---|---|---|---|---|
| `decision.structured-judgment` — decision nodes return their owned structured judgment; the graph advances execution and state, and `answer` produces the user-visible reply | [shared decision infrastructure](concepts/prompt-knowledge-layers.md) | [Prompt knowledge layers](concepts/prompt-knowledge-layers.md), [decision prompt design](../PET_AGENT_DECISION_SYSTEM_PROMPT_DESIGN.md) | [`sharedPrefix.prompt.ts`](../../packages/pet-agent/src/agent/orchestrator/prompts/templates/sharedPrefix.prompt.ts), [`schemas.ts`](../../packages/pet-agent/src/agent/orchestrator/schemas.ts), [`orchestrationDecision.ts`](../../packages/pet-agent/src/agent/orchestrator/runtime/decisions/orchestrationDecision.ts) | [`prompts.test.ts`](../../packages/pet-agent/src/agent/orchestrator/prompts.test.ts), [`schemas.test.ts`](../../packages/pet-agent/src/agent/orchestrator/schemas.test.ts) |
| `entry.execution-shape` — choose `answer`, `direct_task`, or `needs_plan` by whether new execution is required, its target is determined, and it requires prior planning | [`entryDecision`](concepts/decision-node-ownership.md#vertical-decisions) | [State-query investigation](investigations/entry-decision-state-query-routing.md), [#416](https://github.com/pinpawo/pinpawo-agent/issues/416) | [`entryDecision.prompt.ts`](../../packages/pet-agent/src/agent/orchestrator/prompts/templates/entryDecision.prompt.ts), [`schemas.ts`](../../packages/pet-agent/src/agent/orchestrator/schemas.ts) | [`entry-decision-basics.ts`](../../packages/pet-agent/evals/datasets/entry-decision-basics.ts), [`orchestrator-route.eval.ts`](../../packages/pet-agent/evals/orchestrator-route.eval.ts) |
| `planner.execution-boundary` — preserve completed work as fact, use returned results to materialize one executable current task, and maintain only the unstarted future tail | [`capabilityPlanner`](concepts/decision-node-ownership.md#vertical-decisions) | [CapabilityPlanner task boundaries](decisions/capability-planner-task-boundaries.md), [decision prompt design](../PET_AGENT_DECISION_SYSTEM_PROMPT_DESIGN.md) | [`capabilityPlanner.prompt.ts`](../../packages/pet-agent/src/agent/orchestrator/prompts/templates/capabilityPlanner.prompt.ts), [`orchestrationDecision.ts`](../../packages/pet-agent/src/agent/orchestrator/runtime/decisions/orchestrationDecision.ts), [`schemas.ts`](../../packages/pet-agent/src/agent/orchestrator/schemas.ts) | [`capability-planning-basics.ts`](../../packages/pet-agent/evals/datasets/capability-planning-basics.ts), [`capability-planning-evaluation.ts`](../../packages/pet-agent/evals/capability-planning-evaluation.ts), [`capability-planning-evaluation.test.ts`](../../packages/pet-agent/evals/capability-planning-evaluation.test.ts) |
| `capability.executor-selection` — select the available executor that can complete the immutable current task and best fits it, or explicitly return `unavailable` when none can | [`capabilityDecision`](concepts/decision-node-ownership.md#vertical-decisions) | [Decision node ownership](concepts/decision-node-ownership.md#capability-selection-boundary), [decision prompt design](../PET_AGENT_DECISION_SYSTEM_PROMPT_DESIGN.md) | [`capabilityDecision.prompt.ts`](../../packages/pet-agent/src/agent/orchestrator/prompts/templates/capabilityDecision.prompt.ts), [`schemas.ts`](../../packages/pet-agent/src/agent/orchestrator/schemas.ts), [`orchestrationDecision.ts`](../../packages/pet-agent/src/agent/orchestrator/runtime/decisions/orchestrationDecision.ts) | [`capability-decision-basics.ts`](../../packages/pet-agent/evals/datasets/capability-decision-basics.ts), [`decision-eval-scenarios.ts`](../../packages/pet-agent/evals/decision-eval-scenarios.ts), [`orchestrator.test.ts`](../../packages/pet-agent/src/agent/orchestrator/orchestrator.test.ts) |
| `outcome.announce-verdict` — validate the current announce as continued work, current-task completion, user-goal completion, or a user-input boundary | [`outcomeDecision`](concepts/decision-node-ownership.md#vertical-decisions) | [Decision node ownership](concepts/decision-node-ownership.md), [terminal semantics](../ORCHESTRATOR_TERMINAL_SEMANTICS_DRAFT.md), [message context and provenance](concepts/message-context-and-provenance.md) | [`outcomeDecision.prompt.ts`](../../packages/pet-agent/src/agent/orchestrator/prompts/templates/outcomeDecision.prompt.ts), [`schemas.ts`](../../packages/pet-agent/src/agent/orchestrator/schemas.ts), [`orchestrationDecision.ts`](../../packages/pet-agent/src/agent/orchestrator/runtime/decisions/orchestrationDecision.ts) | [`outcome-decision-basics.ts`](../../packages/pet-agent/evals/datasets/outcome-decision-basics.ts), [`decision-eval-scenarios.ts`](../../packages/pet-agent/evals/decision-eval-scenarios.ts), [`orchestrator.test.ts`](../../packages/pet-agent/src/agent/orchestrator/orchestrator.test.ts) |
| `answer.user-visible-close` — fulfil the current reply objective, using a fixed acknowledgement only for genuine goal completion and returning control without a false completion claim when user input is required | [`answer`](concepts/decision-node-ownership.md#vertical-decisions) | [Delegation completion acknowledgement](decisions/delegation-completion-acknowledgement.md), [terminal semantics](../ORCHESTRATOR_TERMINAL_SEMANTICS_DRAFT.md), [message context and provenance](concepts/message-context-and-provenance.md) | [`answer.prompt.ts`](../../packages/pet-agent/src/agent/orchestrator/prompts/templates/answer.prompt.ts), [`answer.ts`](../../packages/pet-agent/src/agent/orchestrator/runtime/nodes/answer.ts), [`state.ts`](../../packages/pet-agent/src/agent/orchestrator/state.ts) | [`answer-behavior-basics.ts`](../../packages/pet-agent/evals/datasets/answer-behavior-basics.ts), [`answer-eval-scenarios.ts`](../../packages/pet-agent/evals/answer-eval-scenarios.ts), [`orchestrator.test.ts`](../../packages/pet-agent/src/agent/orchestrator/orchestrator.test.ts) |

Maintenance stays deliberately small:

- add or split a row only when a stable behavior contract gains a distinct owner;
- update a row when its meaning, owner, design source, implementation, or
  verification changes;
- do not inventory individual prompt sentences, model-specific tuning notes, or
  historical clause versions here; those remain in prompt files, source pages,
  issues, evals, and Git history.

### Verification derives from the contract

The contract in each row is also the source of truth for its eval objective.
Verification does not begin from a reusable metric list. It instantiates the
owned behavior in a concrete case:

```text
stable behavior contract
  -> case objective
  -> acceptance criteria
  -> goal-achieved judgment
  -> error classification and run diagnostics
```

Only the objective and its acceptance criteria determine semantic success.
Schema validity, invocation status, token use, latency, cost, output length, and
similar measurements remain separate run evidence unless the stable contract
explicitly makes one of them part of success. The detailed application to each
current prompt lives in
[System Prompt Authoring Principles](concepts/system-prompt-authoring-principles.md#evaluation-targets-derived-from-prompt-contracts).

## Evolution, not replacement

The present architecture accumulated through several deliberate steps:

- #345 separated static prompt contracts from dynamic facts.
- #349–#352 introduced capability-aware planning and vertically owned decisions.
- #338 established the completion acknowledgement at the answer boundary.
- #363/#366 separated downward delegation briefing from upward handoff.
- #370 removed global recent-announce recall and preserved canonical message order.
- #398/#404 made metadata and message IDs the only protocol identity signals.
- PR #461 refines planner state as immutable completed facts plus a mutable
  result-bounded future tail and removes unused future-task status labels.
- PR #467 separates genuine goal completion from the user-input boundary and
  makes typed outcome state, rather than handoff provenance, select the answer
  close.

New work should state which of these accepted decisions it extends, revises, or
supersedes. An isolated prompt edit is not enough when it changes the meaning of
an action or message role.

## EntryDecision follow-up under review

The [entryDecision state-query investigation](investigations/entry-decision-state-query-routing.md)
found a semantic gap introduced during the planner prompt refactor: the older
taskDecision contract explicitly classified reading, searching, running, and
external access as execution, while the migrated entry prompt broadly classified
questions about recent status as `answer`. The current follow-up applies an
ordered execution → target → plan decision and passes all 36 GLM-5.2 entry runs,
but its operation-oriented definition and increasingly explicit eval requests do
not yet establish generalization. The boundary is being re-derived from the
[practical-reasoning philosophy](concepts/orchestrator-practical-reasoning.md)
rather than from the current capability inventory.
This review does not redesign unrelated answer, handoff, or provenance
mechanisms.

The accepted follow-up structure is tracked by
[issue #418](https://github.com/pinpawo/pinpawo-agent/issues/418):

- [#416](https://github.com/pinpawo/pinpawo-agent/issues/416) owns the narrow,
  domain-independent evidence/execution semantic correction;
- [#417](https://github.com/pinpawo/pinpawo-agent/issues/417) owns the incremental
  positive-first prompt refactor;
- [#415](https://github.com/pinpawo/pinpawo-agent/issues/415) owns the Prompt
  Contract Map and maintenance workflow.

## Knowledge health

The source set is unusually strong on historical design, but weaker on:

- natural-language and cross-model validation of the entry boundary;
- complete verification coverage for each stable behavior contract in the map;
- page-level freshness/dependency checks when implementation changes;
- a consistent status distinction among current, pinned, draft, superseded, and
  historical top-level documents.

These gaps drive the [open questions](questions/system-prompts-open-questions.md)
and [docs migration plan](migrations/docs-wiki-management-plan.md).
