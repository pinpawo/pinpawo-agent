---
title: Capability Planner Owns Task Boundaries And Capability Selection
page_type: decision
status: validated
updated: 2026-07-31
sources:
  - ../../PET_AGENT_DECISION_SYSTEM_PROMPT_DESIGN.md
  - ../../../packages/pet-agent/src/agent/orchestrator/capabilityPlannerAgent.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/capabilityPlannerRunner.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/capabilityPlannerFileExplorer.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/capabilityDocumentWorkspace.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/runtime/nodes/capabilityPlanner.ts
  - ../../../packages/pet-agent/evals/datasets/capability-planning-basics.ts
  - ../../../packages/pet-agent/evals/capability-planning-evaluation.ts
  - https://github.com/pinpawo/pinpawo-agent/issues/473
  - https://github.com/pinpawo/pinpawo-agent/issues/490
  - https://github.com/pinpawo/pinpawo-agent/pull/474
  - https://github.com/pinpawo/pinpawo-agent/pull/480
  - https://github.com/pinpawo/pinpawo-agent/pull/483
  - https://github.com/pinpawo/pinpawo-agent/pull/492
  - https://github.com/pinpawo/pinpawo-agent/pull/515
related:
  - ../overview.md
  - ../capability-toolkit-architecture.md
  - ../concepts/decision-node-ownership.md
  - ../concepts/system-prompt-authoring-principles.md
  - ../questions/system-prompts-open-questions.md
---

# Capability Planner Owns Task Boundaries And Capability Selection

## Decision

Every run that needs a new result enters one Capability Planner Agent. The
Planner:

1. explores the immutable Capability Document Workspace;
2. forms the current independently executable task;
3. selects the concrete Capability that owns it;
4. maintains the ordered, unstarted future plan.

All execution-requiring entry paths use this same deliberation. Task formation
and concrete actor choice are not split across separate stages.

## Why task formation and selection are one judgment

A task boundary is meaningful only relative to an actor that can carry the work
continuously to a useful result. Separating the two judgments created a lossy
handoff:

```text
user purpose
  -> abstract task + capability intent
  -> intermediate code-ranked candidate list
  -> second executor choice
```

The final executor could be chosen from an incomplete candidate set, while the
task-forming model could not inspect the complete instructions and Toolkit scope
of the actors it was planning around.

The accepted flow keeps the deliberation intact:

```text
user purpose + completed facts + future tail
  -> model explores CAPABILITY.md files
  -> current task + concrete Capability + revised future tail
```

The registry still remains deterministic. It materializes the map; it does not
decide which path through that map fits the purpose.

## Capability Document Workspace

For one compiled registry generation, the runtime publishes a content-addressed
directory containing one `CAPABILITY.md` per allowed compiled Capability and
exposes it to the Planner only through read tools. Typed workspace metadata
carries the registry digest, allowed names, document paths, digests, and
provenance.

The Planner receives:

- the workspace root contract and registry digest;
- `glob_search` for bounded discovery;
- `grep_search` for literal text exploration;
- `view_file_chunk` for bounded document reading.

These tools are private Planner infrastructure. They are not Toolkits, are not
available to Capability subagents, and do not become a third extension concept.

Filesystem containment, symlink rejection, digest verification, observation
budgets, iteration limits, and timeouts are code-owned invariants. The model owns
what to explore and how the observed documents change the plan.

## Task boundary

A task continues while one Capability can work continuously toward one useful,
independently accepted result. Internal preparation, action, verification, and
reporting remain one task when the same Capability can naturally own them.

A new boundary is justified when:

- later work cannot be decided until the current result returns;
- a different Capability must execute independently; or
- the user goal contains a separately useful deliverable or acceptance point.

Verb count, implementation phases, or anticipated intermediate artifacts do not
determine task count.

## Entry and boundary modes

At `entry`, the Planner starts from the complete user purpose and canonical
conversation. It forms the first executable task and preserves only necessary
future purposes.

At `boundary`, the Planner receives:

| Input | Role |
|---|---|
| User intent context | Purpose and interpretation |
| `completed_tasks` | Immutable facts about accepted work |
| `latest_handoff` | The newest complete result |
| `remaining_plan` | Mutable, unstarted future work |
| Capability Document Workspace | Current executable actor map |

It may concretize, revise, reorder, or remove the future tail as returned facts
change what remains useful. Completed work cannot re-enter the future plan.

There is no `direct` mode and no externally staged immutable pending task.

## Structured result contract

The Planner returns one of two result shapes:

```ts
type CapabilityPlannerResult =
  | {
      result: 'next_task';
      next_task: {
        objective: string;
        capability_intent: string;
        capability_name: string;
        context_summary: string | null;
      };
      remaining_plan: Array<{
        objective: string;
        capability_intent: string;
      }>;
    }
  | {
      result: 'unavailable';
      task: string;
      reason: string;
    };
```

`capability_name` is concrete only for the current task. Future work retains a
semantic `capability_intent` because its details may depend on results that do
not yet exist.

The Planner has no `answer` result. Entering it means the run still needs a new
result. If a completed Capability also completes the user goal,
`outcomeDecision` must return `goal_done` before another Planner call.

## General fallback

`general` is an ordinary Capability and an explicit Planner policy when it is
present in the current Workspace:

- if a specialized Capability completely fits the current task, select it;
- otherwise, if `general` exists, read its document and select
  `capability_name: "general"`;
- return `unavailable` only when no executable Capability, including `general`,
  can proceed.

The Planner uses the standard `createAgent` `responseFormat` and
`structuredResponse` path. The available result schemas are derived from the
Workspace:

- an empty Workspace exposes only `unavailable`;
- a Workspace containing `general` exposes only `next_task`;
- another non-empty Workspace exposes both result shapes.

Schema errors return correctable tool feedback inside the standard agent loop.
This makes a false `unavailable` invalid when `general` is present without
silently selecting an executor in code.

This is not a code-selected fallback: the Planner still owns the task,
Capability selection, and evidence trail.

## Runtime mapping

For `next_task`, runtime code:

1. verifies that the selected name belongs to the immutable workspace;
2. materializes one `RunNextDelegation`;
3. replaces the future tail with `remaining_plan`;
4. routes to the unified Capability executor.

For truthful `unavailable`, runtime preserves the unexecuted task and reason as
answer context and creates no delegation.

## Evaluation contract

Planner evaluation owns:

- appropriate document exploration;
- current task correctness;
- concrete current Capability selection;
- preservation of user purpose;
- justified task boundaries;
- correct use of completed facts and latest handoff;
- semantic validity of the future tail;
- mandatory General fallback.

Schema validity, filesystem containment, observation budgets, exact workspace
membership, iteration limits, and the General invariant also have deterministic
tests. Task count, plan-effect labels, tokens, latency, and cost remain
diagnostics unless a case explicitly makes them part of success.

## Consequences

- The model explores the registry as a map instead of consuming a coded ranking.
- Capability count affects bounded workspace exploration rather than prompt
  injection of every full document.
- Planning and actor choice cannot drift through an intermediate candidate
  algorithm.
- General remains an ordinary Capability while still providing a reliable
  no-specialist path.
- Goal completion has one owner: `outcomeDecision`.
