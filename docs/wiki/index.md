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
- [System prompt authoring principles](concepts/system-prompt-authoring-principles.md)
  — positive-first contracts, narrow negative boundaries, harness ownership,
  objective-derived eval targets, and eval-backed prompt changes.
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
- [Model prompting and harness references](sources/model-prompting-and-harness-references.md)
  — current official model guidance and primary ACI evidence.
- [Open questions](questions/system-prompts-open-questions.md) — unresolved prompt
  architecture questions.

## Local-agent session projection

- [Local-agent session projection](local-agent-session-projection.md) — system
  synthesis: how checkpoint, snapshot, shared reducer, review lifecycle, and
  transports fit together.
- [Checkpoint, snapshot, timeline, and timeline state](concepts/checkpoint-snapshot-timeline.md)
  — the four distinct domain terms and the completion-replaces-timeline lifecycle.
- [Session projection ownership boundaries](concepts/session-projection-ownership.md)
  — one owner per fact: shared/checkpoint, TUI-local, and server transport-control.
- [Local-agent transport boundary](concepts/local-agent-transport-boundary.md) —
  peer identity, WebSocket/stdio parity, and one-implementation session commands.
- [Active run view as a discriminated union](decisions/run-view-discriminated-union.md)
  — making illegal `running / waiting_review / interrupting` states unrepresentable.
- [Review resolution progress is client-local](decisions/review-resolution-is-client-local.md)
  — why `ReviewAction` carries no status and the server lifecycle stays unprojected.
- [Session projection open questions](questions/session-projection-open-questions.md)
  — TUI wire migration, a future API projection, and deferred snapshot coordinates.

## Documentation management

- [Karpathy LLM Wiki source](sources/karpathy-llm-wiki.md) — method adopted and
  repository-specific adaptations.
- [Docs wiki management plan](migrations/docs-wiki-management-plan.md) — staged
  rollout for all existing documentation.

## Maintenance

Follow [the documentation schema](../AGENTS.md). Every ingest updates this index
when it creates or materially changes a wiki page, then appends an entry to
[the log](../log.md).
