---
title: Delegation Completion Acknowledgement
page_type: decision
status: contested
updated: 2026-08-09
sources:
  - ../../ORCHESTRATOR_TERMINAL_SEMANTICS_DRAFT.md
  - ../../PET_AGENT_DECISION_SYSTEM_PROMPT_DESIGN.md
  - ../../DYNAMIC_CONTEXT_GOVERNANCE_DESIGN.md
  - ../../../packages/pet-agent/src/agent/orchestrator/schemas.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/state.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/runtime/decisions/orchestrationDecision.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/runtime/nodes/answer.ts
  - https://github.com/pinpawo/pinpawo-agent/pull/338
  - https://github.com/pinpawo/pinpawo-agent/pull/467
  - https://github.com/pinpawo/pinpawo-agent/pull/492
related:
  - ../concepts/orchestrator-practical-reasoning.md
  - ../concepts/message-context-and-provenance.md
  - ../concepts/decision-node-ownership.md
  - ../concepts/dynamic-context-governance.md
---

# Delegation Completion Acknowledgement

## Decision

An accepted handoff establishes that a local result has entered the main
conversation. It does not establish that the current task or user goal is
complete.

`outcomeDecision` supplies one of four meanings:

| Outcome | Meaning | Next owner |
|---|---|---|
| `continue` | The current task is incomplete and the same executor can continue | current executor |
| `task_done` | The current task is complete and the user goal still has autonomous follow-up work | boundary Planner |
| `goal_done` | The user goal is complete | answer fixed completion acknowledgement |
| `user_input_required` | The user goal is incomplete and continuation requires user input | answer return-control close |

The fixed acknowledgement remains a distinct final main message for
`goal_done`. It gives main messages a stable completed lifecycle shape without
repeating the full deliverable that already entered main through handoff.

The boundary Planner can return planning facts to Answer only when autonomous
execution cannot proceed or user input is required. That result is not a
goal-completion judgment. If the current result makes a conditional follow-up
unnecessary and therefore completes the user goal, `outcomeDecision` must choose
`goal_done`, not `task_done`.

For `task_done`, runtime dispatches the completed task, the accepted announce
result bounded as one complete-result representation, and the unstarted future plan to
the boundary Planner. It does not route a clipped display preview or the full
main conversation as a substitute for those typed facts.

For `user_input_required`, answer instead states the accepted progress and
unfinished effect, then asks for the missing information. Returning control is
also a terminal close for the current run, but it is not a completion
acknowledgement.

## Rationale

Before this decision, answer could reproduce or re-summarize the complete announce,
creating duplicated task content and inconsistent terminal messages. PR #338
introduced an explicit completion mode while preserving full main history for
future queries.

The original implementation selected completion mode from handoff provenance.
That was sufficient while every accepted handoff meant completion, but became
false when `goal_done` also represented a run that needed user clarification or
confirmation. In the reproduced failure, the handed-off result explicitly said
that a report had not been sent because the channel was missing, while answer
still emitted `"task"已完成`.

PR #467 separates `user_input_required` from `goal_done`. The graph carries the
accepted non-continue outcome through run-scoped typed state. Answer combines
that state with the latest handoff source and selects either
[`buildDelegationCompletionAnswerContext()`](../../../packages/pet-agent/src/agent/orchestrator/runtime/nodes/answer.ts)
or the user-input-required reply objective. It does not re-read announce prose
to infer terminal meaning.

Provenance remains the source of message identity and result origin. Typed
outcome state remains the source of terminal meaning. The context shown to the
answer model uses user-facing goal and status terms; it does not require the
model to understand handoff, delegation, run identifiers, or the rest of the
orchestration flow.

## Current implementation conflict

The terminal meanings and fixed `goal_done` acknowledgement remain accepted.
Their current model-facing implementation is contested because
`buildDelegationCompletionAnswerContext()` embeds task-derived completion prose
in the system message. The target dynamic-context contract makes the fixed close
deterministic and represents other Answer modes as bounded facts outside the
stable system contract. This preserves the semantic decision while replacing
the conflicting authority and placement mechanism.

## Constraints

- Keep the completion acknowledgement as a distinct final main message when
  `goal_done` is established.
- Keep accepted handoff content in main as the task result.
- Do not collapse the acknowledgement into the handoff merely to reduce tokens.
- Do not infer completion mode from handoff provenance or wording in the handoff
  body.
- Preserve incomplete facts and ask for the missing user input when the accepted
  outcome is `user_input_required`.
- Express the model-visible reply objective in user-facing task and status terms;
  keep lifecycle identifiers in runtime provenance.
- Changes to wording may be considered separately, but must preserve the stable
  message lifecycle, truthful terminal meaning, and non-repetition purpose.

## Consequences

Prompt investigations must not treat the existence of a second assistant message
as accidental duplication. The important distinctions are semantic:

- handoff carries the accepted result;
- typed outcome identifies what that result establishes;
- answer restores common ground with either a truthful completion
  acknowledgement or a request for the user commitment still required.

The paired GLM-5.2 profile preserved the genuine completion acknowledgement at
`3/3` and improved the user-input-required close from `0/3` to `3/3`. Across the
combined outcome and answer run, all 32 evaluable goals passed; the single
provider timeout passed when rerun in isolation.
