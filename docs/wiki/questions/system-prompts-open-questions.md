---
title: System Prompt Design Open Questions
page_type: question
status: draft
updated: 2026-07-26
sources:
  - ../../PET_AGENT_DECISION_SYSTEM_PROMPT_DESIGN.md
  - ../../CAPABILITY_PLANNER_TASK_HORIZON_DRAFT.md
  - ../investigations/entry-decision-state-query-routing.md
  - https://github.com/pinpawo/pinpawo-agent/issues/435
related:
  - ../overview.md
  - ../concepts/orchestrator-practical-reasoning.md
  - ../concepts/prompt-knowledge-layers.md
  - ../concepts/system-prompt-authoring-principles.md
  - ../decisions/capability-planner-task-boundaries.md
  - ../migrations/docs-wiki-management-plan.md
---

# System Prompt Design Open Questions

## Reopened by boundary-model review

### What counts as a new execution result?

[PR #421](https://github.com/pinpawo/pinpawo-agent/pull/421) restored the
important distinction between answering and obtaining a new result. The later
exclusion-flow candidate passed its explicit GLM-5.2 cases, but operation lists
do not define a future capability-independent boundary and “sufficient existing
evidence” remains underspecified.

The draft [practical-reasoning philosophy](../concepts/orchestrator-practical-reasoning.md)
reframes execution as crossing an epistemic or causal boundary: obtaining
required external evidence or producing a required external effect. Closure
requires natural-language paired cases, a revised production prompt, and
provider validation. Issue
[#435](https://github.com/pinpawo/pinpawo-agent/issues/435) continues to track the
provider-level profile.

## Resolved for V1

### Is the minimal Prompt Contract Map sufficient?

Yes for the current V1 scope. [Issue
#415](https://github.com/pinpawo/pinpawo-agent/issues/415) established one row
per stable behavior contract with five relations: contract, owner, design
source, implementation, and verification. The #416 and #417 changes were
represented without adding a clause manifest or another persistent field.

Revisit the map shape only when a concrete contract cannot be traced with these
relations.

## P1 — evidence validation

### What evidence makes an existing-state answer safe?

A handoff may explicitly report a fact, while an ordinary assistant message may
only repeat an intention. The production boundary is now canonical, but
provider-level sufficiency and freshness behavior still needs measured evidence.

Validation evidence:

- evidence-role definition tied to message provenance;
- evals for explicit handoff evidence, stale observations, and unsupported
  inference;
- route accuracy and unnecessary-execution comparison across supported models.

### Does result-bounded planning generalize across model families?

The fixed GLM-5.2 capabilityPlanner profile now has three evaluable passes for
each of six entry/boundary cases. This validates the current profile and model,
not the generality of the decomposition language.

Closure evidence:

- run the unchanged goal contract and case set across supported model families;
- distinguish subject behavior failures from schema, invocation, and judge
  failures;
- keep model-specific protocol adaptations conditional without changing the
  accepted [task-boundary decision](../decisions/capability-planner-task-boundaries.md).

## P1 — prompt governance

### Does the repository need configurable product policy in prompts?

No accepted general policy-injection abstraction currently exists. Arbitrary
runtime instruction strings would weaken the static-contract/facts boundary.

Closure evidence:

- concrete product policies that cannot be represented as facts, typed config,
  capability instructions, or deterministic guards;
- owner/scope/trust/conflict semantics;
- tests proving policies do not redefine structured-output meanings.

## P2 — maintenance

### Which design documents are current, historical, or superseded?

Many top-level files carry status prose, but the repository has no uniform
frontmatter or dependency graph. The docs migration plan must classify these
before moving or rewriting them.

### How should wiki staleness be detected?

Initial lint can validate links, frontmatter, and registered sources. Later lint
may compare source revisions or declared dependencies, but generated indexes must
remain inspectable and reproducible.
