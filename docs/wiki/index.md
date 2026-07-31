---
title: Documentation Wiki Index
page_type: overview
status: draft
updated: 2026-07-31
sources:
  - ../AGENTS.md
related:
  - overview.md
  - capability-toolkit-architecture.md
  - concepts/dynamic-context-governance.md
  - concepts/orchestrator-practical-reasoning.md
  - decisions/capability-planner-task-boundaries.md
  - decisions/delegation-completion-acknowledgement.md
  - interruption-and-delegation-continuation.md
  - migrations/docs-wiki-management-plan.md
---

# Documentation Wiki

This is the synthesized knowledge layer for the repository documentation. Start
with an overview, then follow concept, decision, investigation, and source links.
Existing files outside `docs/wiki/` remain source material until they are
explicitly migrated.

## Capability / Toolkit

- [Capability / Toolkit V2 architecture](capability-toolkit-architecture.md) —
  validated system synthesis covering authoring, Toolkit composition, registry
  compilation, General as an ordinary Capability, execution, artifacts, and
  host responsibilities.
- [Decision node ownership](concepts/decision-node-ownership.md) — the
  four semantic owners and the Planner-owned task/Capability boundary.
- [Message context and provenance](concepts/message-context-and-provenance.md) —
  private Capability lanes, announce, and accepted handoff.

## System prompt design

- [System prompt knowledge map](overview.md) — current synthesis and relationship
  map.
- [Orchestrator as practical reasoning](concepts/orchestrator-practical-reasoning.md)
  — draft philosophical model for purpose, interpretation, knowledge, judgment,
  action, responsibility, time, and completion.
- [Prompt knowledge layers](concepts/prompt-knowledge-layers.md) — static contract,
  conditional protocol, injected facts, and deterministic enforcement.
- [Dynamic context governance](concepts/dynamic-context-governance.md) — draft
  ownership contract for projection, typed facts, rendering, message placement,
  and invocation assembly.
- [System prompt authoring principles](concepts/system-prompt-authoring-principles.md)
  — positive-first contracts, narrow negative boundaries, harness ownership,
  objective-derived eval targets, and eval-backed prompt changes.
- [Decision node ownership](concepts/decision-node-ownership.md) — semantic owner
  of result availability, task and Capability planning, announce verdicts, and
  user-visible replies.
- [CapabilityPlanner task boundaries](decisions/capability-planner-task-boundaries.md)
  — filesystem exploration, current task and Capability selection,
  Workspace-derived structured results, General fallback, and result-driven
  future-plan revision.
- [Message context and provenance](concepts/message-context-and-provenance.md) —
  canonical main messages, private lanes, announce, handoff, and trusted identity.
- [Delegation completion acknowledgement](decisions/delegation-completion-acknowledgement.md)
  — why the fixed completion close exists, why handoff alone cannot trigger it,
  and how answer returns control when user input is required.
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
- [Interruption and delegation continuation](interruption-and-delegation-continuation.md)
  — end-to-end contract for run settlement, waiting-review Esc, retained
  delegation lanes, and the fresh-versus-continued next request.
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
