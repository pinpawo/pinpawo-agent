---
title: Orchestrator Decision Node Ownership
page_type: concept
status: validated
updated: 2026-07-31
sources:
  - ../../PET_AGENT_DECISION_SYSTEM_PROMPT_DESIGN.md
  - ../../ORCHESTRATOR_TERMINAL_SEMANTICS_DRAFT.md
  - ../../PET_AGENT_API_CAPABILITY_TOOLKIT.md
  - ../../../packages/pet-agent/src/agent/orchestrator/capabilityPlannerAgent.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/runtime/decisions/orchestrationDecision.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/runtime/nodes/capabilityPlanner.ts
  - https://github.com/pinpawo/pinpawo-agent/issues/490
  - https://github.com/pinpawo/pinpawo-agent/pull/492
  - https://github.com/pinpawo/pinpawo-agent/pull/515
related:
  - ../capability-toolkit-architecture.md
  - orchestrator-practical-reasoning.md
  - prompt-knowledge-layers.md
  - system-prompt-authoring-principles.md
  - message-context-and-provenance.md
  - ../decisions/capability-planner-task-boundaries.md
  - ../decisions/delegation-completion-acknowledgement.md
---

# Orchestrator Decision Node Ownership

## Vertical decisions

Each semantic owner receives the evidence needed for one coherent question:

| Node | Owns | Does not own |
|---|---|---|
| `entryDecision` | Whether canonical main context can support a reply now or the goal still requires a new result | Task formation, Capability discovery or selection, execution, user reply |
| Capability Planner Agent | Capability-document exploration, current task boundary, concrete Capability selection, and the unstarted future plan | Tool execution for the user task, announce acceptance, user reply |
| `outcomeDecision` | Whether the current announce means continue, current-task completion with later autonomous work, user-goal completion, or required user input | Next-task generation, Capability selection, user reply |
| `answer` | The user-visible reply selected from canonical conversation and typed terminal context | Tool execution and graph-state decisions |

The graph and schemas enforce legal transitions around these judgments. They do
not replace a model-owned semantic choice with keywords, relevance scores, or a
hidden fallback.

## Entry result-availability boundary

`entryDecision` runs once at run entry:

- `answer` means the main conversation already contains enough result evidence
  for the reply, or consequential ambiguity requires asking the user;
- `needs_plan` means the goal still requires reading, observation, calculation,
  modification, external access, or another new result.

Entry does not decide whether the work is one task or several. A single
executable request still enters the Planner. This keeps result availability
separate from task grouping and Capability choice.

## Planner boundary

The Planner is a framework-internal subagent with a private transcript and
private read-only tools. It explores the materialized Capability Document
Workspace instead of receiving an in-memory relevance ranking.

It owns both halves of one deliberation:

1. what independently useful task should be executed now; and
2. which compiled Capability can completely own that task.

This ownership is intentionally unified. Splitting task formation and executor
selection allowed one model to describe an abstract ability while another model
or code path reinterpreted it against a truncated candidate set.

The Planner returns:

- `next_task` with the objective, capability intent, concrete
  `capability_name`, context summary, and unstarted future tail; or
- `unavailable` only when the workspace contains no executable Capability able
  to proceed and no `general`.

When specialized Capabilities do not match but `general` exists, selecting
`general` is Planner policy expressed through the same document-reading and
structured-result contract. Response-format construction omits `unavailable`
when `general` exists; code does not silently rewrite the selected Capability.

## Task and future-plan boundary

A task is one Capability execution that can continuously produce one useful,
independently accepted result. A new boundary is justified when later work:

- depends on the current result;
- requires a different Capability to act independently; or
- has its own meaningful acceptance point.

Completed tasks and accepted handoffs are immutable facts. The Planner may
revise, reorder, concretize, or remove only unstarted future work.

## Outcome and terminal-close boundary

`outcomeDecision` owns terminal meaning:

- `continue`: the current task is incomplete and the same Capability can close
  the gap;
- `task_done`: the current task is complete and the user goal still has
  autonomous work for the boundary Planner;
- `goal_done`: the user goal is complete;
- `user_input_required`: the user goal is incomplete and the next progress
  requires user input.

The Planner has no `answer` result. Consequently `task_done` cannot mean “the
task is complete and perhaps nothing remains”; that case is `goal_done`.

Handoff provenance records where accepted evidence came from. Typed outcome
state records what the evidence establishes. `answer` communicates that state
without re-judging the announce.

## Mechanical ownership

Code remains responsible for:

- registry compilation and the immutable Capability workspace generation;
- filesystem containment, digest verification, read budgets, and iteration
  limits;
- structured-output validation and selected-name membership;
- workspace-derived result availability, including the `general` fallback
  invariant;
- lane creation, state updates, routing, and cleanup.

These invariants may be described to the Planner when needed for correction,
but their enforcement does not depend on prompt compliance.

## Change discipline

When changing a decision contract:

1. identify the actor that has the required evidence;
2. keep one semantic question with one owner;
3. distinguish model judgment from deterministic state enforcement;
4. update schema, runtime transition, Prompt Contract Map, and eval objective
   together;
5. record an ownership change as a design decision rather than a prompt wording
   tweak.
