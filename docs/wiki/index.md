---
title: Documentation Wiki Index
page_type: overview
status: draft
updated: 2026-07-20
sources:
  - ../AGENTS.md
related:
  - overview.md
  - migrations/docs-wiki-management-plan.md
---

# Documentation Wiki

This is the synthesized knowledge layer for the repository documentation. Start
with an overview, then follow concept, decision, investigation, and source links.
Existing files outside `docs/wiki/` remain source material until they are
explicitly migrated.

## System prompt design

- [System prompt knowledge map](overview.md) — current synthesis and relationship
  map.
- [Prompt knowledge layers](concepts/prompt-knowledge-layers.md) — static contract,
  conditional protocol, injected facts, and deterministic enforcement.
- [Decision node ownership](concepts/decision-node-ownership.md) — semantic owner
  of each orchestrator decision.
- [Message context and provenance](concepts/message-context-and-provenance.md) —
  canonical main messages, private lanes, announce, handoff, and trusted identity.
- [Delegation completion acknowledgement](decisions/delegation-completion-acknowledgement.md)
  — why the fixed completion close exists and what must remain stable.
- [State-query routing investigation](investigations/entry-decision-state-query-routing.md)
  — current regression analysis around `answer` versus new execution.
- [System prompt source registry](sources/system-prompts-source-registry.md) — source
  coverage and authority.
- [Open questions](questions/system-prompts-open-questions.md) — unresolved prompt
  architecture questions.

## Documentation management

- [Karpathy LLM Wiki source](sources/karpathy-llm-wiki.md) — method adopted and
  repository-specific adaptations.
- [Docs wiki management plan](migrations/docs-wiki-management-plan.md) — staged
  rollout for all existing documentation.

## Maintenance

Follow [the documentation schema](../AGENTS.md). Every ingest updates this index
when it creates or materially changes a wiki page, then appends an entry to
[the log](../log.md).
