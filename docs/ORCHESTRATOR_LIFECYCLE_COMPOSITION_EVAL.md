# Orchestrator Lifecycle Composition Eval

Status: candidate validation; keep outside the wiki until the profile is
accepted and explicitly ingested.

## Purpose

Per-node prompt evals answer whether one decision or answer contract behaves
correctly in isolation. They do not prove that the contracts compose into a
truthful completed run.

The lifecycle composition eval covers that missing level:

```text
user goal
  -> production orchestrator graph
  -> production decision and answer prompts on one real model
  -> controlled executor evidence
  -> user-visible lifecycle
  -> goal-based judge
```

The controlled executor does not decide routing, planning, completion, or
answer text. It only returns predetermined evidence when the graph invokes an
executor. This isolates orchestrator reasoning from filesystem, network, tool,
and environment variance.

## Evaluation ownership

The primary verdict belongs to the user goal represented by each case.
Acceptance criteria evaluate the complete user-visible lifecycle together with
the controlled evidence and execution trajectory. A run does not pass merely
because each local decision looks plausible.

Mechanical invariants remain separate:

- terminal run state is clean;
- no private lane message remains in the main state;
- at least one user-visible assistant message exists;
- every executor call has controlled evidence assigned to its current user turn;
  a call without evidence stops the run and preserves the attempted task.

Executor-call counts, decision kinds, routes, task text, delegation summaries,
latencies, token usage, and output variants are diagnostics. They explain a
failure but do not replace the goal verdict.

## Initial single-model profile

The fixed profile uses seven lifecycle cases, each repeated three times:

1. direct answer without execution;
2. one executable task followed by genuine completion;
3. investigation followed by handoff-informed implementation;
4. continuation of one incomplete analysis task until its evidence scope is complete;
5. truthful return when user input is required;
6. a later user turn resuming the unfinished goal;
7. truthful close when no execution capability is available.

The production graph uses the configured model for `entryDecision`, the private
Capability Planner agent, `outcomeDecision`, and `answer`. The Planner explores
the real Capability Document Workspace and submits its final plan through its
private tool contract. Executor outputs are scripted facts. The same configured
model performs the existing `prompt-goal-v1` evaluation after the graph finishes.

## Failure ownership and candidate repair

The first complete GLM-5.2 run exposed composition failures that isolated node
profiles had not represented:

- goal completion was previously deferred to a boundary Planner `answer`,
  leaving terminal ownership split between outcomeDecision and the Planner;
- `capabilityPlanner` could split one investigation result into repeated tasks
  or turn an available code-change capability into an unrequested repair goal;
- an underspecified user-input lifecycle case allowed a valid immediate
  clarification path while its criteria required a prior public check;
- `task_done` and `user_input_required` overlapped when the current task was
  complete but the next progress still required user-owned information.

The candidate changes stay with the narrow owners:

- the user-input case now explicitly requests the public check before the
  protected deployment-state check;
- outcomeDecision owns the terminal distinction: `goal_done` ends autonomous
  work, while `task_done` guarantees that later autonomous work remains for the
  boundary Planner;
- the Planner never returns `answer`; when no specialized Capability matches,
  it selects registered `general`, and only reports `unavailable` when no
  executable Capability (including `general`) exists;
- planner treats the user request as the source of ends and the capability
  registry as available means, and keeps evidence gathering, analysis, and
  verification for one investigation result inside one task boundary;
- outcome makes terminal user input and autonomously plannable task completion
  mutually exclusive, including their overlap example;
- the planner goal evaluator always scores the future tail and can apply an
  explicit case-level task-count invariant when the task-boundary objective
  requires it.

Before the clean candidate baseline, the complete planner/outcome profile
achieved `39/39`, and the two lifecycle cases that originally exposed the
failures achieved `6/6`. These results locate the repair; the clean full
lifecycle profile remains the release gate.

## Evidence and reports

Run:

```sh
npm run eval:lifecycle-composition -w @pinpawo/pet-agent
```

Useful filters:

```sh
LIFECYCLE_EVAL_CASES=dynamic-multi-task \
LIFECYCLE_EVAL_REPEATS=1 \
  npm run eval:lifecycle-composition -w @pinpawo/pet-agent
```

The runner reads model configuration from the existing prompt-eval resolution
path and writes a versioned JSON report under
`packages/pet-agent/.eval-results/`. It records:

- tested commit, harness revision, dirty state, changed paths, and diff hash;
- provider, model, structured-output method, and evaluator configuration;
- every structured decision output;
- every controlled executor input and returned fact;
- every user-visible assistant message per turn;
- goal-criterion and mechanical-invariant results;
- subject and evaluator token usage.

Generated reports remain local evidence and are not committed.

## Change gate

First establish the lifecycle baseline on GLM-5.2. If a case fails
reproducibly, use its full trajectory to locate the owning contract. Change
production behavior only when the failure is not a provider error or an
ambiguous evaluation case, and compare the minimal owner-level repair against
the unchanged lifecycle profile.

After the single-model profile is stable, it can become an input to the
multi-model contract validation tracked separately. Cross-model comparison
must not change the cases, criteria, executor evidence, or evaluator ownership.
