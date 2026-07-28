---
title: System Prompt Design Open Questions
page_type: question
status: draft
updated: 2026-07-29
sources:
  - ../../PET_AGENT_DECISION_SYSTEM_PROMPT_DESIGN.md
  - ../../PET_AGENT_API_CAPABILITY_TOOLKIT.md
  - ../decisions/capability-planner-task-boundaries.md
  - ../../../packages/pet-agent/evals/datasets/entry-decision-basics.ts
  - ../../../packages/pet-agent/evals/datasets/capability-planning-basics.ts
  - https://github.com/pinpawo/pinpawo-agent/issues/435
  - https://github.com/pinpawo/pinpawo-agent/issues/490
related:
  - ../overview.md
  - ../capability-toolkit-architecture.md
  - ../concepts/orchestrator-practical-reasoning.md
  - ../concepts/prompt-knowledge-layers.md
  - ../concepts/system-prompt-authoring-principles.md
  - ../decisions/capability-planner-task-boundaries.md
  - ../migrations/docs-wiki-management-plan.md
---

# System Prompt Design Open Questions

## P1 — entry evidence

### What evidence makes an existing-result answer safe?

Entry now owns only result availability, but “the main conversation already
contains the result” still requires correspondence and freshness judgments.
An accepted handoff may establish a fact; an ordinary assistant message may
only describe an intention or stale observation.

Closure evidence:

- paired cases for completion versus intention;
- matching and mismatching object, scope, and time;
- current-state requests with stale observations;
- clarification where ambiguity materially changes the action;
- validation across supported model families.

Issue [#435](https://github.com/pinpawo/pinpawo-agent/issues/435) remains the
provider-level evidence trail.

## P1 — Planner exploration

### Does filesystem exploration generalize across model families?

The Planner now discovers and reads `CAPABILITY.md` files through private tools.
Local tests prove tool protocol, containment, budgets, submission validation, and
runtime mapping. They do not prove that every supported model explores enough
documents or chooses the best Capability.

Closure evidence:

- the same task/selection goal contract across supported models;
- specific-Capability, General fallback, and truthful-unavailable cases;
- tasks whose relevant Capability is not obvious from its directory name;
- result-dependent boundary replanning;
- separation of subject-model failures from tool, schema, timeout, and evaluator
  failures.

### How should a large Capability registry remain navigable?

The Workspace prevents every full instruction document from entering the initial
prompt, but a large tree still creates discovery, observation-budget, and latency
pressure.

Required evidence before changing the architecture:

- registry-size profiles with deterministic directory layouts;
- files observed, tool calls, iterations, input tokens, latency, and selection
  success;
- cases where literal grep is insufficient and the model must navigate by the
  map structure;
- evidence that a proposed index or hierarchy helps without reintroducing a
  coded relevance decision.

Possible map improvements must remain model-explorable. A function that chooses
or ranks Capabilities on the model's behalf would reverse the accepted design.

## P1 — lifecycle composition

### Does the strict `task_done` boundary avoid redundant work?

The Planner has no `answer` result. Therefore outcome must use:

- `goal_done` when the user goal is complete;
- `task_done` only when later autonomous work remains.

Closure evidence:

- conditional follow-up that becomes unnecessary after the result;
- multi-deliverable work where a real later task remains;
- a completed task followed by required user input;
- lifecycle runs proving no extra General delegation is created after goal
  completion.

## P1 — prompt governance

### Does the repository need configurable product policy in prompts?

No accepted general policy-injection abstraction exists. Arbitrary runtime
instruction strings would weaken the static-contract/facts boundary.

Closure evidence:

- concrete policies that cannot be represented as typed config, Capability
  instructions, Toolkit policy, or deterministic guards;
- owner, scope, trust, and conflict semantics;
- tests proving injected policy cannot redefine structured-output meanings.

## P2 — documentation maintenance

### How should Wiki staleness be detected?

Initial lint should validate links, required frontmatter, source existence, and
orphan pages. Later lint may compare source revisions or declared dependencies,
but generated indexes must remain inspectable and reproducible.

### Which historical evidence should stay directly navigable?

Current Wiki pages should not teach removed graph topology. Git history and the
source registry preserve evolution, but future ingest needs a consistent rule
for when a superseded investigation remains a historical page versus only a
source-registry entry.
