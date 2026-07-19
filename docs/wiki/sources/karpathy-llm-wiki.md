---
title: Karpathy LLM Wiki Method
page_type: source
status: validated
updated: 2026-07-20
sources:
  - https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
related:
  - ../concepts/prompt-knowledge-layers.md
  - ../migrations/docs-wiki-management-plan.md
---

# Karpathy LLM Wiki Method

## Source

Andrej Karpathy's [LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f),
created 2026-04-05 and read for this repository on 2026-07-20.

## Relevant method

The source proposes a persistent, compounding knowledge artifact rather than
re-deriving answers from raw documents on every query. Its three layers are:

1. immutable raw sources;
2. an LLM-maintained, interlinked Markdown wiki;
3. a schema document such as `AGENTS.md` that defines structure and workflows.

The recurring operations are:

- **Ingest** — integrate a source into summaries, entities, concepts, links, the
  index, and the chronological log.
- **Query** — answer from already-synthesized knowledge and file durable new
  synthesis back into the wiki.
- **Lint** — find contradictions, stale claims, orphan pages, missing concepts,
  broken links, and evidence gaps.

`index.md` is content-oriented; `log.md` is chronological and append-only.

## Repository adaptation

This repository cannot treat all existing design documents as immutable raw
files: some are living specifications, some are historical plans, and current
behavior ultimately comes from implementation and tests. The adapted source
model is therefore:

- implementation/tests for current observed behavior;
- accepted designs and merged PRs for intended decisions;
- Git history and superseded documents for evolution;
- traces for bounded observations;
- external references for methods.

The wiki must preserve these roles rather than blending them into an undifferentiated
summary. Existing documents are initially registered as sources and migrated only
after their authority and inbound links are understood.

## What is not adopted yet

- No embedding or vector search infrastructure is introduced.
- No existing document is moved merely to fit a new directory taxonomy.
- No automatic content rewrite is performed when sources conflict.
- Obsidian-specific syntax is optional; repository links remain standard Markdown.
