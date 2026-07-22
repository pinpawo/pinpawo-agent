---
title: System Prompt Design Open Questions
page_type: question
status: draft
updated: 2026-07-22
sources:
  - ../../PET_AGENT_DECISION_SYSTEM_PROMPT_DESIGN.md
  - ../investigations/entry-decision-state-query-routing.md
  - https://github.com/pinpawo/pinpawo-agent/issues/435
related:
  - ../overview.md
  - ../concepts/prompt-knowledge-layers.md
  - ../concepts/system-prompt-authoring-principles.md
  - ../migrations/docs-wiki-management-plan.md
---

# System Prompt Design Open Questions

## Resolved for V1

### What counts as a new execution result?

[PR #421](https://github.com/pinpawo/pinpawo-agent/pull/421) established a
stable, domain-independent contract: a new observation, read, search, lookup,
verification, calculation, command, tool result, or external/current-state
check is execution when the evidence is not already in the canonical
conversation. Read-only work still counts as execution.

The remaining provider-level validation is tracked in
[issue #435](https://github.com/pinpawo/pinpawo-agent/issues/435), rather than
reopening this design question.

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
