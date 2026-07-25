---
title: Orchestrator Decision Node Ownership
page_type: concept
status: validated
updated: 2026-07-26
sources:
  - ../../PET_AGENT_DELEGATION_STATE_AND_TASK_ROUTING.md
  - ../../PET_AGENT_DECISION_NODE_OWNERSHIP_AUDIT.md
  - ../../PET_AGENT_DECISION_SYSTEM_PROMPT_DESIGN.md
related:
  - orchestrator-practical-reasoning.md
  - prompt-knowledge-layers.md
  - system-prompt-authoring-principles.md
  - message-context-and-provenance.md
  - ../decisions/capability-planner-task-boundaries.md
  - ../investigations/entry-decision-state-query-routing.md
---

# Orchestrator Decision Node Ownership

## Vertical decisions

Each decision node owns one semantic question:

| Node | Owns | Does not own |
|---|---|---|
| `entryDecision` | Whether the run can answer now, needs one execution boundary, or needs planning | Capability selection, plan creation, tool execution, user reply |
| `capabilityPlanner` | Capability execution boundaries and materialization of the next task | Concrete capability ID, announce acceptance, user reply |
| `capabilityDecision` | Which currently available executor best fits the already-defined task | Task rewriting, planning, completion judgment |
| `outcomeDecision` | Whether the current announce is sufficient for the current task and whether autonomous work continues | Next-task generation, capability selection, user reply |
| `answer` | The fixed user-visible close for a terminal run state | Tool execution and graph-state decisions |

The graph and schema enforce the transitions around those decisions. The model
should not receive state conditions merely to reproduce a deterministic route.

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

## Ownership change discipline

When changing a prompt:

1. identify the semantic owner;
2. check whether an older node already owned the same judgment;
3. preserve the accepted meaning when renaming or splitting nodes;
4. update schema descriptions and evals with the same wording;
5. record intentional ownership changes as decisions, not incidental prompt edits.
