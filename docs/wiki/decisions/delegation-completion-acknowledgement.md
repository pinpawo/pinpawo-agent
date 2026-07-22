---
title: Delegation Completion Acknowledgement
page_type: decision
status: validated
updated: 2026-07-23
sources:
  - ../../../packages/pet-agent/src/agent/orchestrator/runtime/nodes/answer.ts
  - https://github.com/pinpawo/pinpawo-agent/pull/338
related:
  - ../concepts/message-context-and-provenance.md
  - ../concepts/decision-node-ownership.md
---

# Delegation Completion Acknowledgement

## Decision

After an accepted delegation handoff becomes the latest main message, the answer
node emits a short, fixed-purpose completion acknowledgement.

The acknowledgement exists to give main messages a stable terminal shape. It
summarizes orchestration-level completion — what kind of delegation finished,
whether it completed, and whether user direction is needed — without repeating
the full deliverable that already entered main through handoff.

## Rationale

Before this decision, answer could reproduce or re-summarize the complete announce,
creating duplicated task content and inconsistent terminal messages. PR #338
introduced an explicit completion mode while preserving full main history for
future queries.

The implementation is
[`buildDelegationCompletionAnswerContext()`](../../../packages/pet-agent/src/agent/orchestrator/runtime/nodes/answer.ts).
It is selected from handoff provenance rather than message text.

Provenance remains a runtime concern. The context shown to the answer model uses
the user goal, the completed work, and the required user-visible close; it does
not require the model to understand handoff, delegation, run identifiers, or the
rest of the orchestration flow.

## Constraints

- Keep the completion acknowledgement as a distinct final main message.
- Keep accepted handoff content in main as the task result.
- Do not collapse the acknowledgement into the handoff merely to reduce tokens.
- Do not infer completion mode from wording in the handoff body.
- Express the model-visible reply objective in user-facing task and status terms;
  keep lifecycle identifiers in runtime provenance.
- Changes to wording may be considered separately, but must preserve the stable
  message lifecycle and the non-repetition purpose.

## Consequences

Prompt investigations must not treat the existence of a second assistant message
as accidental duplication. The important distinction is semantic: handoff carries
the result; acknowledgement closes the delegation lifecycle.
