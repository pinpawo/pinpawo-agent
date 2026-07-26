---
title: Orchestrator Decision Node Ownership
page_type: concept
status: validated
updated: 2026-07-26
sources:
  - ../../PET_AGENT_DELEGATION_STATE_AND_TASK_ROUTING.md
  - ../../PET_AGENT_DECISION_NODE_OWNERSHIP_AUDIT.md
  - ../../PET_AGENT_DECISION_SYSTEM_PROMPT_DESIGN.md
  - ../../ORCHESTRATOR_TERMINAL_SEMANTICS_DRAFT.md
related:
  - orchestrator-practical-reasoning.md
  - prompt-knowledge-layers.md
  - system-prompt-authoring-principles.md
  - message-context-and-provenance.md
  - ../decisions/capability-planner-task-boundaries.md
  - ../decisions/delegation-completion-acknowledgement.md
  - ../investigations/entry-decision-state-query-routing.md
---

# Orchestrator Decision Node Ownership

## Vertical decisions

Each decision node owns one semantic question:

| Node | Owns | Does not own |
|---|---|---|
| `entryDecision` | Whether the run can answer now, needs one execution boundary, or needs planning | Capability selection, plan creation, tool execution, user reply |
| `capabilityPlanner` | Capability execution boundaries and materialization of the next task | Concrete capability ID, announce acceptance, user reply |
| `capabilityDecision` | Which currently available executor can complete and best fits the already-defined task, or that none can | Task rewriting, replanning, completion judgment, user reply |
| `outcomeDecision` | Whether the current announce means continue, current-task completion, user-goal completion, or that further progress requires user input | Next-task generation, capability selection, user reply |
| `answer` | The user-visible close selected from the explicit terminal state, including fixed completion acknowledgement and return-control replies | Tool execution and graph-state decisions |

The graph and schema enforce the transitions around those decisions. The model
should not receive state conditions merely to reproduce a deterministic route.

## Outcome and terminal-close boundary

`outcomeDecision` owns the semantic judgment, but it does not write a reply or
invent the next task. Its model-visible schema distinguishes:

- `continue`: the same executor can close the current task gap;
- `task_done`: the current task is accepted and planning owns what follows;
- `goal_done`: the user goal is established as complete;
- `user_input_required`: the user goal is incomplete and further progress
  requires user input.

The graph carries accepted non-continue meaning through typed run state and owns
the deterministic routes. Handoff provenance remains evidence identity, not a
completion signal. `answer` communicates the supplied state without re-judging
the announce: only `goal_done` receives the fixed completion acknowledgement,
while `user_input_required` states progress and asks for the missing input.

## Capability execution boundary

A task is one isolated capability execution boundary, not one grammatical step in
the user request. Related actions belong together when one executor can naturally
complete and validate them. Separate boundaries are justified by dependency on a
future handoff, different capability intent, or a meaningful independent
acceptance point.

The draft
[CapabilityPlanner task-boundary decision](../decisions/capability-planner-task-boundaries.md)
refines this ownership without moving it: completed tasks remain immutable
facts, while the planner uses returned results to revise only `next_task` and
the unstarted `remaining_plan` tail. Runtime code preserves and maps that state
but does not decide how the future plan changes.

The draft [practical-reasoning philosophy](orchestrator-practical-reasoning.md)
defines the underlying reason for execution: the user goal requires evidence or
an effect beyond the current conversational boundary. This principle is broader
than any fixed inventory of read, search, calculation, command, or mutation
operations.

## Entry execution shape

The original taskDecision contract treated reading, searching, modifying,
running, external access, and specialized capability calls as execution. The
current three-way entry contract must preserve that semantic distinction:

- `answer` means no new capability execution is required or the execution target
  still requires user clarification;
- `direct_task` means execution is required and can proceed as one current task
  without prior planning;
- `needs_plan` means execution is required and must first be organized into
  independently executable tasks.

Whether the user phrased a request as a question is not itself an execution-shape
decision.

## Capability selection boundary

Every executor is an ordinary Capability. The host may register the well-known
`general` Capability, but it has no separate selection value, lane, registry
slot, or execution node. It is selected as `capability.general`, runs in
`capability:general`, and uses the same compiled Capability executor as its
peers.

Capability search narrows the candidate set; a search hit is evidence of
relevance, not proof of executability. When registered and compiled, `general`
is retained as the planner's default candidate so the decision model—not a code
fallback—chooses between it and more specific candidates. The schema contains
only `capability.<candidate-name>` values plus the explicit `unavailable`
result. With no candidate at all, code can return `unavailable` without invoking
the model.

`unavailable` creates no delegation and sends the run to `answer` with the
unexecuted task still visible as terminal context. It does not authorize
`capabilityDecision` to split the task, change the plan, partially execute the
task, or invent an executor. Capability descriptions support selection; after
selection, execution behavior remains owned by the selected capability's
runtime instructions and tools.

## Ownership change discipline

When changing a prompt:

1. identify the semantic owner;
2. check whether an older node already owned the same judgment;
3. preserve the accepted meaning when renaming or splitting nodes;
4. update schema descriptions and evals with the same wording;
5. record intentional ownership changes as decisions, not incidental prompt edits.
