# Orchestrator Terminal Semantics Draft

Status: historical implementation draft. The independent Outcome model described
below was replaced by the #619 trace-scoped persistent private Planner. See
[`PERSISTENT_PRIVATE_PLANNER_REFACTOR_ISSUE.md`](./PERSISTENT_PRIVATE_PLANNER_REFACTOR_ISSUE.md)
for the current control contract. Keep this document as migration context only.

## Problem

The orchestrator must distinguish two questions:

1. Why should autonomous execution stop?
2. What can it truthfully say has been completed?

The former outcome contract collapsed these questions. `goal_done` meant either
that the user goal is complete or that execution cannot continue without user
input. Both routes accept the current handoff, mark the delegation completed,
and enter `answer`. Because `answer` formerly derived a fixed completion acknowledgement
from the accepted handoff, a run that merely needed a user choice could claim that
the task and user goal are complete.

This conflicts with the existing practical-reasoning distinction:

```text
execution stopped
  != current task completed
  != user goal completed
```

A truthful post-delegation close remains required. Its behavior must follow the
typed terminal meaning and canonical result evidence.

## Baseline composition

```text
outcomeDecision
  goal_done
    -> accept handoff
    -> mark delegation completed
    -> answer detects handoff provenance
    -> fixed "<task>已完成" acknowledgement
```

This composition is truthful when the announce establishes the user goal. It is
not truthful when the announce says that a required user decision is still
missing.

Per-node evaluation does not currently expose the composition:

- the outcome case accepts `goal_done` as the correct stop verdict when user
  input is required;
- the answer completion case assumes a genuinely completed handoff;
- neither case verifies the status handed from outcome to answer.

## Semantic distinctions to preserve

These are behavioral distinctions, not proposed enum names:

| Situation | Current task established | More autonomous work justified | User goal established | User control required | Truthful close |
|---|---:|---:|---:|---:|---|
| Current executor can close a concrete gap | no | yes | no | no | continue the same task |
| Current task is complete and later work remains | yes | yes | no | no | plan from the accepted result |
| User goal is complete | yes | no | yes | no | grounded task completion summary |
| Execution needs a user choice or clarification | not necessarily | no | no | yes | state what is complete and ask for the missing commitment |
| No available executor can perform the task | no | no | no | possibly | state the unexecuted work and limitation |

An accepted handoff means that a local result is admitted into the main
conversation. It does not, by itself, prove current-task or user-goal
completion.

## Ownership constraints

- `outcomeDecision` owns interpretation of the current announce against the
  current task and user goal.
- The graph owns routing, state updates, and whether a delegation is recorded as
  completed.
- `answer` owns user-visible communication from the terminal state supplied by
  the graph.
- Handoff provenance identifies the source of accepted evidence. It must not be
  used as a proxy for goal completion.
- A typed outcome, rather than prompt wording or handoff text, carries terminal
  meaning across nodes.

## Evaluation before redesign

The first paired lifecycle case uses the same user goal and local result across
the outcome and answer boundaries:

```text
user goal:
  根据我的选择，把已经完成的报告发送到邮件或项目群。

current task:
  确认发送渠道并发送已经完成的报告。

announce:
  报告已经完成，但用户尚未选择邮件或项目群，当前无法继续发送。
```

The accepted final behavior must:

- preserve the fact that the report itself is ready;
- say that sending has not occurred;
- ask the user to choose the channel;
- avoid claiming that the current task or user goal is complete.

This case is intentionally paired with a genuine-completion summary case. Both
must pass: completed work must be summarized, while incomplete work must not be
presented as complete.

## Baseline result

The working-tree harness was evaluated with GLM-5.2 on 2026-07-26, using three
runs per answer case:

| Case | Goal achieved |
|---|---:|
| direct answer | 3/3 |
| handoff synthesis | 3/3 |
| historical replay | 3/3 |
| clarification question | 3/3 |
| genuine delegation completion acknowledgement | 3/3 |
| handed-off result that still requires a user choice | 0/3 |

All three failing runs produced the same text:

```text
"确认发送渠道并发送已经完成的报告"已完成。如需继续，请告诉我。
```

In every run, the judge rejected the output for omitting the unsent state,
failing to ask for the channel, and falsely claiming completion. The exact
output stability, paired with the genuine completion case passing 3/3, shows
that the model is consistently following the supplied completion objective.
The failure is therefore in terminal-state composition rather than answer-model
instability.

The generated local report is:

```text
packages/pet-agent/.eval-results/prompt-stability-bbd546d7819a-1785018211594.json
```

## Accepted contract

The validated design makes the semantic distinction explicit:

```ts
type DelegationOutcome =
  | 'continue'
  | 'task_done'
  | 'goal_done'
  | 'user_input_required';
```

- `goal_done` means only that the user goal is complete.
- `user_input_required` means that the goal is incomplete and autonomous
  execution cannot continue without user input.
- Every accepted non-continue announce is copied into the main conversation as
  a handoff. This records evidence provenance, not completion.
- The graph carries the accepted outcome through run-scoped state. `answer`
  receives that state directly and does not infer it from handoff metadata or
  announce text.
- Only `goal_done` uses the task completion summary mode. Answer grounds that
  summary in canonical conversation and handoff evidence.
  `user_input_required` asks for the missing input while preserving completed
  and incomplete facts from the handed-off result.
- `task_done` means the current task is complete and the user goal still has
  autonomous work, so it routes to the boundary planner. If the current result
  also completes the user goal, outcomeDecision must return `goal_done`;
  the Planner has no `answer` result.
- outcomeDecision receives the Planner's existing future tail as advisory
  context for that distinction. The tail is neither a fact nor a mandatory
  queue: empty and non-empty tails must both be reconciled with the user goal
  and the current announce. Outcome may determine that planned future work is
  no longer applicable, but it does not generate or rewrite the plan.

This keeps each semantic owner narrow: outcomeDecision classifies the accepted
result, the graph transitions and records it, and answer communicates it.

## Validation after implementation

The combined outcome-and-answer harness was evaluated with GLM-5.2 on
2026-07-26, using three runs per case.

| Target | Case | Goal achieved |
|---|---|---:|
| outcome | same executor can continue | 3/3 |
| outcome | current task done, later work remains | 2/3 evaluable; 1 provider timeout |
| outcome | user goal complete | 3/3 |
| outcome | incomplete current task can continue | 3/3 |
| outcome | user input required | 3/3 |
| answer | direct answer | 3/3 |
| answer | handoff synthesis | 3/3 |
| answer | historical replay | 3/3 |
| answer | clarification question | 3/3 |
| answer | genuine completion acknowledgement | 3/3 |
| answer | handed-off result requiring user choice | 3/3 |

All 32 evaluable runs passed their goal-based criteria. The single provider
timeout was rerun in isolation and passed as `task_done`, completing semantic
verification of all 33 requested runs without treating the infrastructure
timeout as a model verdict.

Reports:

```text
packages/pet-agent/.eval-results/prompt-stability-bbd546d7819a-1785054409497.json
packages/pet-agent/.eval-results/prompt-stability-bbd546d7819a-1785054440560.json
```

The decision gate is satisfied: the paired lifecycle case is reproducible,
both terminal meanings are represented, the graph transition is deterministic,
and outcome and answer evals share the same typed meaning. The current Answer
contract additionally turns genuine completion into a grounded task summary.
