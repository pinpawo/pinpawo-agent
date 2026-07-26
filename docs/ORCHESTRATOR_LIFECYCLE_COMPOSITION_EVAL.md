# Orchestrator Lifecycle Composition Eval

Status: implementation draft; keep outside the wiki until the profile is
validated and explicitly ingested.

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
- the controlled executor is called exactly as many times as the case permits.

Decision kinds, routes, task text, delegation summaries, latencies, token usage,
and output variants are diagnostics. They explain a failure but do not replace
the goal verdict.

## Initial single-model profile

The fixed profile uses seven lifecycle cases, each repeated three times:

1. direct answer without execution;
2. one executable task followed by genuine completion;
3. investigation followed by handoff-informed implementation;
4. continuation of one incomplete analysis task until its evidence scope is complete;
5. truthful return when user input is required;
6. a later user turn resuming the unfinished goal;
7. truthful close when no execution capability is available.

The production graph uses the configured model for `entryDecision`,
`capabilityPlanner`, `capabilityDecision`, `outcomeDecision`, and `answer`.
Executor outputs are scripted facts. The same configured model performs the
existing `prompt-goal-v1` evaluation after the graph finishes.

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

This stage does not modify production prompts. First establish the lifecycle
baseline on GLM-5.2. If a case fails reproducibly, use its full trajectory to
locate the owning contract. Only then should a minimal production contract
change be proposed and compared against the unchanged lifecycle profile.

After the single-model profile is stable, it can become an input to the
multi-model contract validation tracked separately. Cross-model comparison
must not change the cases, criteria, executor evidence, or evaluator ownership.
