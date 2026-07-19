---
title: Documentation Wiki Management Plan
page_type: migration
status: draft
updated: 2026-07-20
sources:
  - ../../AGENTS.md
  - ../sources/karpathy-llm-wiki.md
  - ../../index.md
related:
  - ../index.md
  - ../questions/system-prompts-open-questions.md
---

# Documentation Wiki Management Plan

## Objective

Manage the entire `docs/` tree as a source-backed, continuously synthesized wiki
without breaking existing links or erasing historical rationale.

## Current state

The directory contains 73 Markdown files across several forms:

- current API/reference material;
- pinned architecture and subsystem designs;
- refactor plans and iteration plans;
- historical diagnoses;
- implementation-alignment checklists;
- external references;
- one already-structured capability artifact topic;
- one deeply structured TUI alignment topic.

Their filenames and inline status notes are useful but inconsistent. Related
decisions are distributed across multiple documents and GitHub history.

## Target model

```text
docs/
  AGENTS.md           schema and workflows
  index.md            catalog of sources and wiki knowledge
  log.md              append-only maintenance history
  wiki/               synthesized, interlinked knowledge
    concepts/
    decisions/
    investigations/
    questions/
    sources/
    migrations/
  existing sources    retained in place until topic migration is approved
```

The target is organizational, not merely a directory layout. A topic is managed
as wiki knowledge when its current model, decisions, evidence, relationships,
history, and open questions can be navigated without rereading every raw design
document.

## Phases

### Phase 0 — foundation

Status: completed by the initial system prompt ingest.

- Add schema, index, log, and wiki directories.
- Define evidence roles, page types, status values, and workflows.
- Preserve all existing paths.

### Phase 1 — prompt design pilot

Status: initial ingest complete; review and validation remain.

- Register implementation, docs, PRs/issues, tests/evals, trace observations, and
  the external wiki method.
- Build concept and decision pages across sources.
- Record contradictions and regressions as investigations.
- Use this topic to refine the schema before broader migration.

### Phase 2 — inventory and classification

- Assign each existing document a topic, source role, lifecycle status, and
  likely canonical successor.
- Identify duplicate or overlapping design documents.
- Generate an inbound-link report before approving moves.
- Prioritize active/high-churn topics: orchestrator, capability artifacts,
  context/guards/HITL, Studio runtime, and TUI.

### Phase 3 — topic-by-topic ingest

For each topic:

1. ingest current implementation and tests;
2. ingest all current and historical design documents;
3. register relevant issues and merged PRs;
4. create overview, concepts, decisions, investigations, and questions;
5. mark source documents current, superseded, or historical;
6. update index and log;
7. run link and contradiction lint.

Do not process every file in one undifferentiated batch. Topic boundaries create
useful review units and reduce cross-reference drift.

### Phase 4 — canonicalization

After a topic wiki is validated:

- decide which source documents remain authoritative references;
- mark superseded documents explicitly;
- merge duplicate current guidance into canonical wiki/system pages;
- move files only when all inbound links can be updated safely;
- retain historical rationale through source pages and Git history.

### Phase 5 — automated lint

Start with deterministic checks:

- required frontmatter;
- valid status/page type;
- broken local links;
- orphan wiki pages;
- unregistered docs;
- missing index entries;
- duplicate titles or canonical IDs.

Add semantic lint only after deterministic health checks are reliable:

- stale current claims;
- contradictions between implementation and wiki;
- new source changes with affected downstream pages;
- missing concept or decision pages.

## Proposed topic order

1. Orchestrator decisions and system prompts — pilot already started.
2. Delegation, message lanes, context governance, and guards.
3. Capability runtime and artifact pipeline.
4. Studio orchestrator, run controller, and scheduler.
5. TUI architecture and alignment series.
6. API references and plugin protocol.
7. Workdir/workspace runtime configuration.

## Migration guardrails

- No bulk rename of `docs/`.
- No source deletion merely because synthesis exists.
- No automatic “latest document wins” rule.
- No generated database required for the initial system.
- GitHub-compatible Markdown remains the portable source format.
- Every content migration states what it supersedes and why.
