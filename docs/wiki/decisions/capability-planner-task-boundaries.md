---
title: Capability Planner Owns Task Boundaries And Capability Selection
page_type: decision
status: validated
updated: 2026-08-09
sources:
  - ../../PET_AGENT_DECISION_SYSTEM_PROMPT_DESIGN.md
  - ../../../packages/pet-agent/src/agent/orchestrator/capabilityPlanner/agent.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/capabilityPlanner/runner.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/capabilityPlanner/fileExplorer.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/capabilityPlanner/documentWorkspace.ts
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

The Planner receives the Workspace contract and one private exploration action:
`grep_search`. A query contains one to three short literal alternatives. Each
match includes the complete `CAPABILITY.md` document, so discovery and document
observation do not require a second file-reading action.

These tools are private Planner infrastructure. They are not Toolkits, are not
available to Capability subagents, and do not become a third extension concept.

Filesystem containment, symlink rejection, digest verification, document-read
limits, iteration limits, and timeouts are code-owned invariants.
The model owns what to explore and how the observed documents change the plan.

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

At `entry`, Entry resolves the canonical main conversation into an ephemeral,
bounded Planner briefing. The briefing carries an objective of at most 2,000
characters and optional context of at most 4,000 characters. It is a graph
dispatch value, not durable orchestrator state, and the Planner does not receive
the canonical transcript.

At `boundary`, the Planner receives:

| Input | Role |
|---|---|
| `completedTask` | The task Outcome just accepted as complete |
| `completedTaskResult` | The accepted announce result, bounded to 16,000 characters while preserving its head and tail |
| `remainingPlan` | Mutable, unstarted future work |
| Capability Document Workspace | Current executable actor map |

It may concretize, revise, reorder, or remove the future tail as returned facts
change what remains useful. Completed work cannot re-enter the future plan.

There is no `direct` mode and no externally staged immutable pending task.

## Structured terminal contract

Each Planner invocation finishes through one of two terminal tools. The runtime
normalizes those calls into one of two result shapes:

```ts
type CapabilityPlannerResult =
  | {
      tasks: Array<{
        capability: string;
        task: string;
      }>;
    }
  | {
      answer: {
        reason: string;
        context: string;
        question: string | null;
      };
    };
```

`submit_plan` requires at least one task. The first task runs now; later tasks
remain unstarted and may be revised after execution returns new facts.
`return_to_answer` provides planning facts when execution cannot proceed or a
question must be put to the user. It does not send a reply and does not decide
that the goal is complete. If a completed Capability also completes the user
goal, `outcomeDecision` must return `goal_done` before another Planner call.

## General fallback

`general` is an ordinary Capability when it is present in the current Workspace:

- if a specialized Capability completely fits the current task, select it;
- otherwise, if `general` can perform the task, select it in `submit_plan`;
- if no executable plan can proceed, use `return_to_answer` with the relevant
  planning facts.

The Planner uses standard `createAgent` tools. `submit_plan` is available only
when the Workspace contains a Capability and its `capability` field is an enum
of exact Workspace names. `return_to_answer` remains available for a genuinely
blocked plan or required user input. Schema and tool errors return correctable
feedback inside the standard agent loop.

This is not a code-selected fallback: the Planner still owns the task,
Capability selection, and evidence trail.

## Runtime mapping

For `submit_plan`, runtime code:

1. verifies that the selected name belongs to the immutable workspace;
2. materializes the first task as one `RunNextDelegation`;
3. stores the later tasks as the future tail;
4. routes to the unified Capability executor.

For `return_to_answer`, runtime stores bounded planning facts for Answer and
creates no delegation.

## Evaluation contract

Planner evaluation owns:

- appropriate document exploration;
- current task correctness;
- concrete current Capability selection;
- preservation of user purpose;
- justified task boundaries;
- correct use of the latest completed task and accepted result;
- semantic validity of the future tail;
- appropriate General selection when it can execute the task;
- truthful `return_to_answer` when execution cannot proceed or needs user input.

Schema validity, filesystem containment, document-read limits, exact workspace
membership, iteration limits, and terminal tool protocol also have deterministic
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
