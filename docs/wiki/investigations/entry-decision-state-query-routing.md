---
title: EntryDecision State Query Routing
page_type: investigation
status: draft
updated: 2026-07-21
sources:
  - ../../PET_AGENT_DECISION_SYSTEM_PROMPT_DESIGN.md
  - ../../../packages/pet-agent/src/agent/orchestrator/prompts/templates/entryDecision.prompt.ts
  - ../../../packages/pet-agent/evals/datasets/entry-decision-basics.ts
  - https://github.com/pinpawo/pinpawo-agent/issues/416
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

## Superseded clause

Before the #416 implementation candidate, the production entry prompt listed
questions about existing context, recent task status, or previous results under
`action=answer`.

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

## Implementation candidate

The #416 branch now expresses stable action meanings by evidence and execution
shape rather than question topic:

- `answer`: canonical main messages, including accepted handoffs, contain
  sufficient evidence; no new execution result is required. An intention or plan
  is not completion evidence.
- `direct_task`: one new execution result is required. Observation, reading,
  searching, lookup, verification, calculation, command/tool results, and
  external or current-state checks all count as execution, including read-only
  work.
- `needs_plan`: multiple meaningful execution boundaries are required.

Freshness is part of evidence sufficiency when the user asks about current state.
The classification does not depend on the topic, interrogative form, or words
such as “existing” and “recent.” Git and commit language remains in eval cases,
not the production prompt.

The structured-output schema description uses the same three meanings. The
action enum, graph transitions, message lanes, answer ownership, and fixed
delegation-completion acknowledgement are unchanged.

## Verification status

The entryDecision dataset now covers:

- explicit completion evidence and replay;
- intent without completion evidence;
- absent local and remote current-state evidence;
- stale evidence;
- clarification before execution;
- a new calculation result;
- one shared execution boundary and multiple independent boundaries.

Prompt/schema contract tests pass locally. Prompt preview measurement for the
regression case changed from approximately 1,666 to 1,918 tokens for the full
system, structured context, and conversation input. The added semantic boundary
therefore has an explicit token cost; correctness must be evaluated before any
claim of improvement.

## Evidence still needed

- Run the expanded entryDecision eval set across supported models/providers.
- Check whether removing the broad status clause causes unnecessary execution for
  questions whose answer is explicitly recorded in handoff metadata or text.
- Define what evidence is sufficient for a state claim without creating a
  domain-specific freshness policy inside the prompt.
- Compare route accuracy, unnecessary execution, latency, and cost before
  promoting this investigation or the authoring principles to `validated`.

## Explicitly unaffected decision

The fixed [delegation completion acknowledgement](../decisions/delegation-completion-acknowledgement.md)
is not part of this investigation and remains a stable main-message close.
