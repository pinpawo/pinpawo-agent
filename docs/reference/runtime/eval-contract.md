# Eval Contract

> Scope: how an eval in `packages/pet-agent/evals/` is structured, executed, and
> kept honest.
> Audience: written to be read by an LLM working in this repo.

An eval is only useful if it runs, measures the real system, and can be compared
against a previous run. This document states what each of those requires. It
describes the target state; §7 records where the repository currently diverges.

## 1. The four parts

Every eval is these four, and they are separable on purpose:

| Part | Owns | Lives in |
|---|---|---|
| **Dataset** | cases: input, objective, acceptance criteria | `evals/datasets/*.ts` |
| **Scenario** | how one case becomes a model invocation | `evals/*-eval-scenarios.ts` |
| **Runner** | executing scenarios, repeats, writing a report | `evals/**/*.eval.ts` |
| **Sink** | where results are read afterwards | report file and/or Langfuse |

A dataset without a runner produces nothing. Adding a dataset is not adding
coverage; wiring it to a runner is.

## 2. Execution is always local

Every eval in this repo runs the model **in this process**. Langfuse is a sink,
not an executor: `run-langfuse-*.eval.ts` still builds the agent locally and
calls it, then writes traces and scores to Langfuse.

This matters because it was once assumed otherwise. `sync-langfuse-datasets`
uploads every dataset in `agentEvalDatasets` to the platform, and a dataset that
is only synced looks covered while nothing ever executes it. **Syncing is
publishing, not running.**

Consequences to respect:

- A dataset's coverage is decided by whether a runner imports it, never by
  whether it appears in `agentEvalDatasets`.
- A runner must not require Langfuse credentials in order to execute. Credential
  failure may disable the sink; it must not disable the eval.

## 3. Scoring has two layers, and they are not interchangeable

**Deterministic scorers** own anything derivable from the output's structure:
which tool was called, whether an argument is present and non-empty, whether
user-facing text exists, whether a value is within bounds. These must never
depend on a judge.

**LLM judges** own semantic acceptance: is the recommendation grounded, was the
task restated, is the summary one coherent narrative. Each judged criterion needs
a stated `acceptanceCriteria` entry so a failure names what failed rather than
producing a score alone.

The judge must resolve to a different model profile fingerprint than the
subject. `run-decision-stability` enforces this; new runners must too.

## 4. A harness stub is a contract, not a convenience

When a scenario declares a tool the production code also declares — a
`plan_request` stub, a planner terminal tool — the stub is part of the measured
surface. If it drifts from production, the eval silently measures the wrong
thing and reports it as a model failure.

This has already happened: the `plan_request` stub kept `z.object({})` and "takes
no arguments" for a full PR after production gained a required `goal`. The
scorer read `args.goal`, so every correctly routed run scored zero — 9/18 on
`entry_answer`, entirely fabricated. Fixing the stub returned 17/18 on unchanged
code.

Therefore: **any stub mirroring a production tool needs a deterministic test
asserting the two agree** on name, required parameters, and whether a parameter
is optional. That test belongs in `evals/*.test.ts` and runs with `npm test`.

## 5. A result means nothing without a baseline

A single run cannot distinguish a regression from variance. Before accepting a
prompt or context change:

1. run the unchanged revision and keep its report;
2. run the change with **identical** settings — same subject profile, same judge
   profile, same temperature, same repeat count, same dataset;
3. compare per-case, not only the total.

Judge reasoning is stronger evidence than score deltas. A criterion that fails
with the *same stated reason* across repeats is a real regression; a case whose
score swings between runs at temperature > 0 is variance. Both appeared in one
session: `handoffs_synthesized_once` failed three times for the same reason and
was real; `trace-pr-review-follow-up` moved 2/3 → 1/3 → 3/3 → 1/3 and was not.

Repeats are for separating those two, not for precision. Three is the working
default; raise it only when repeats disagree.

## 6. What a case must be able to observe

A case may only require facts that actually reach the node under test. When a
node's context changes, every case that depended on the removed context becomes
unrunnable and must move or be deleted — a permanently failing case teaches
nothing and hides real regressions.

`handoff-synthesis` and `historical-replay` once required the terminal response
model to reproduce facts that existed only in a prior assistant turn. After the
current finalizer stopped receiving conversation history they failed 3/3 for
structural reasons, independent of any prompt. They were removed rather than
kept as noise; historical replay still exists, but belongs to `entryAnswer`.

Before adding a case, check the node's row in
[Context injection map](context-injection-map.md): if the
fact the case needs is not in that node's context, the case belongs elsewhere.

## 7. Known divergence

Recorded so it is visible rather than rediscovered:

- **32 cases have no runner.** `permission-control-basics` (16),
  `interruption-recovery-basics` (8), `delegation-control-basics` (4) and
  `context-synthesis-basics` (4) are exported, synced to Langfuse, and never
  executed by anything in this repository. They carry no stale concepts — they
  were simply never wired up when the execution model moved local.
- **No CI eval and no archived baseline.** Every comparison is manual, which is
  why the regression in this session was nearly merged.
- **`run-langfuse-*` runners hard-require credentials**, contrary to §2.
