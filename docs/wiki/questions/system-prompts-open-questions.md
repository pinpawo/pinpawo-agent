---
title: System Prompt Design Open Questions
page_type: question
status: draft
updated: 2026-07-20
sources:
  - ../../PET_AGENT_DECISION_SYSTEM_PROMPT_DESIGN.md
  - ../investigations/entry-decision-state-query-routing.md
related:
  - ../overview.md
  - ../concepts/prompt-knowledge-layers.md
  - ../concepts/system-prompt-authoring-principles.md
  - ../migrations/docs-wiki-management-plan.md
---

# System Prompt Design Open Questions

## P0 — action semantics and evidence

### What exactly counts as a new execution result?

The design needs a stable, domain-independent definition that covers read-only
observation without adding examples for every mutable system.

Closure evidence:

- agreed contract wording;
- cross-domain entryDecision evals;
- no regression in explicit-context summary cases.

### What evidence makes an existing-state answer safe?

A handoff may explicitly report a fact, while an ordinary assistant message may
only repeat an intention. The boundary between sufficient recorded evidence and
required re-observation is not yet canonical.

Closure evidence:

- evidence-role definition tied to message provenance;
- evals for explicit handoff evidence, stale observations, and unsupported
  inference.

## P1 — prompt traceability

### Is the minimal Prompt Contract Map sufficient?

Current knowledge is spread across prompt files, design documents, PRs, and tests.
The [initial map](../overview.md#prompt-contract-map) now records one row per
stable behavior contract.

The first version deliberately has only five columns: contract, owner, design
source, implementation, and verification. It does not inventory every clause or
introduce a manifest, lifecycle model, model-scope field, or dedicated lint tool.

Closure evidence:

- reviewers can follow every current node contract to code and evals;
- #416 and #417 can update the map without creating clause-level churn;
- no missing relationship requires adding another persistent field.

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
