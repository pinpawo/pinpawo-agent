---
title: EntryDecision State Query Routing
page_type: investigation
status: draft
updated: 2026-07-20
sources:
  - ../../PET_AGENT_DECISION_SYSTEM_PROMPT_DESIGN.md
  - ../../../packages/pet-agent/src/agent/orchestrator/prompts/templates/entryDecision.prompt.ts
  - ../../../packages/pet-agent/evals/datasets/entry-decision-basics.ts
related:
  - ../concepts/prompt-knowledge-layers.md
  - ../concepts/decision-node-ownership.md
  - ../decisions/delegation-completion-acknowledgement.md
---

# EntryDecision State Query Routing

## Observation

LangSmith run `019f7c5b-4bb0-7456-bd2d-f8d05c1f48b5` observed
`entryDecision` choose `answer` for “你把改动直接commit了？”. The main history
reported file changes but contained no explicit commit hash, Git status, or
statement that no commit occurred.

The exported run was an entry decision, not the later user-visible answer. Its
choice still matters because answer has no execution tools and can only synthesize
the conversation it receives.

## Current clause

The production entry prompt currently lists questions about existing context,
recent task status, or previous results under `action=answer`.

That category combines two different evidence requirements:

- transformation of known content, such as summarizing a conclusion;
- acquisition of a new current-state observation, such as checking Git, a file,
  a process, a test run, or a remote resource.

## Historical comparison

PR #345's predecessor `taskDecision` contract explicitly routed requests that
still required reading, searching, modifying, running, external access, or a
specialized capability into execution.

PR #352 introduced `entryDecision` and the three-way
`answer | direct_task | needs_plan` contract. During that migration, the broad
“recent task status” answer clause appeared, while the older generic definition
of reading/searching/running/external access as execution was no longer explicit.

**Inference:** the observed behavior is best understood as a semantic migration
gap from taskDecision to entryDecision, not evidence that answer, handoff, shared
prefix, or provenance architecture should be redesigned together.

## Proposed generalized boundary

The stable action meanings should express execution shape rather than question
topic:

- `answer`: the existing canonical conversation and accepted handoffs are enough;
  no new capability execution result is required.
- `direct_task`: one new capability execution result is required. Reading,
  searching, observation, verification, calculation, modification, running, and
  external access all count as execution.
- `needs_plan`: multiple meaningful execution boundaries are required.

Git and commit language belongs in eval cases, not the production prompt.

## Evidence still needed

- Run the expanded entryDecision eval set across supported models/providers.
- Check whether removing the broad status clause causes unnecessary execution for
  questions whose answer is explicitly recorded in handoff metadata or text.
- Define what evidence is sufficient for a state claim without creating a
  domain-specific freshness policy inside the prompt.

## Explicitly unaffected decision

The fixed [delegation completion acknowledgement](../decisions/delegation-completion-acknowledgement.md)
is not part of this investigation and remains a stable main-message close.
