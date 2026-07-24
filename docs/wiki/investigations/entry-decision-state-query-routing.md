---
title: EntryDecision State Query Routing
page_type: investigation
status: validated
updated: 2026-07-24
sources:
  - ../../PET_AGENT_DECISION_SYSTEM_PROMPT_DESIGN.md
  - ../../../packages/pet-agent/src/agent/orchestrator/prompts/templates/entryDecision.prompt.ts
  - ../../../packages/pet-agent/evals/datasets/entry-decision-basics.ts
  - https://github.com/pinpawo/pinpawo-agent/issues/416
  - https://github.com/pinpawo/pinpawo-agent/issues/435
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

## Validated contract

The implementation merged in
[PR #421](https://github.com/pinpawo/pinpawo-agent/pull/421) established the
evidence/execution boundary. The current validated candidate applies it as an
ordered decision:

1. Decide whether the current result requires new execution. Reading, lookup,
   verification, calculation, commands, and current-state checks count as
   execution. An intention or plan is not an existing result.
2. If execution is required, decide whether the execution target is uniquely
   determined. Multiple candidates without a selection basis route to `answer`
   for clarification.
3. For a determined target, decide whether plan is required. Preparation,
   operation, verification, reporting, and related batch work may remain in one
   current task; independent future tasks and result-dependent task
   materialization route to `needs_plan`. Other execution routes to
   `direct_task`.

Freshness is part of evidence sufficiency when the user asks about current state.
The classification does not depend on the topic, interrogative form, or words
such as “existing” and “recent.” Git and commit language remains in eval cases,
not the production prompt.

The structured-output schema describes only the three result meanings: no
execution, execution without plan, and execution requiring plan. The decision
conditions remain in the node prompt rather than being duplicated in the
schema. The action enum, graph transitions, message lanes, answer ownership, and
fixed delegation-completion acknowledgement are unchanged.

## Deterministic verification status

The entryDecision dataset now covers:

- explicit completion evidence and replay;
- intent without completion evidence;
- absent local and remote current-state evidence;
- stale evidence;
- clarification before execution;
- a new calculation result;
- one shared execution boundary and multiple independent boundaries.

Prompt/schema contract tests pass locally. Prompt preview measurement for the
regression case changed from approximately 1,666 to 1,637 tokens for the full
system, structured context, and conversation input. This small reduction is not
itself evidence of improvement; route correctness still requires evaluation.

## GLM-5.2 baseline evidence

The canonical V1 profile at
`d54c6e38e8a26f5a6c0453112b8017ed0467170a` ran every entry case three times
with GLM-5.2. Existing explicit completion evidence, current local and remote
lookups, clarification, calculation, one-boundary work, and multi-boundary
planning passed. Two evidence boundaries failed consistently:

- an intention to commit was treated as completion evidence in all three runs;
- a deployment observation from the previous day was treated as sufficient
  evidence for current state in all three runs.

This isolates the remaining issue to evidence sufficiency and freshness rather
than the broad `answer | direct_task | needs_plan` structure. Historical
before/after comparison and additional-model validation remain tracked in
[issue #435](https://github.com/pinpawo/pinpawo-agent/issues/435). A future
production change must address this shared evidence boundary and rerun the same
cases; it must not add commit- or deployment-specific rules.

## GLM-5.2 candidate validation

The exclusion-flow candidate at
`6e10c8a641489889ab8c414e8e371678b5562a3e` ran all 12 canonical entry cases
three times with DashScope `glm-5.2`, JSON Mode, provider-default reasoning, and
the `prompt-goal-v1` evaluator. All `36/36` goals were achieved with no schema,
invocation, or evaluator errors.

The dataset separates the owned objectives: existing results, intention versus
completion, local and remote observation, stale evidence, clarification,
calculation, one current task with internal actions, recent-context resolution,
result-dependent planning, and independent-task planning. Cases no longer rely
on a hidden capability assignment or combine context recency with an unrelated
batch-boundary judgment.

## Explicitly unaffected decision

The fixed [delegation completion acknowledgement](../decisions/delegation-completion-acknowledgement.md)
is not part of this investigation and remains a stable main-message close.
