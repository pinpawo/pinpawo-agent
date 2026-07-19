---
title: Orchestrator Decision Node Ownership
page_type: concept
status: validated
updated: 2026-07-20
sources:
  - ../../PET_AGENT_DELEGATION_STATE_AND_TASK_ROUTING.md
  - ../../PET_AGENT_DECISION_NODE_OWNERSHIP_AUDIT.md
  - ../../PET_AGENT_DECISION_SYSTEM_PROMPT_DESIGN.md
related:
  - prompt-knowledge-layers.md
  - message-context-and-provenance.md
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

## Entry execution shape

The original taskDecision contract treated reading, searching, modifying,
running, external access, and specialized capability calls as execution. The
current three-way entry contract must preserve that semantic distinction:

- `answer` means no new capability execution result is required;
- `direct_task` means one new capability execution boundary is required;
- `needs_plan` means multiple meaningful boundaries are required.

Whether the user phrased a request as a question is not itself an execution-shape
decision.

## Ownership change discipline

When changing a prompt:

1. identify the semantic owner;
2. check whether an older node already owned the same judgment;
3. preserve the accepted meaning when renaming or splitting nodes;
4. update schema descriptions and evals with the same wording;
5. record intentional ownership changes as decisions, not incidental prompt edits.
