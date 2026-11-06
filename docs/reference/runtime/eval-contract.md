# Eval Contract

> Scope: how an eval in `tests/agent-evals/src/` is structured, executed, and
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
`plan_request` stub, a Supervisor command tool — the stub is part of the measured
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

## 8. Budget handoff coverage

The context cases in `npm run eval:budget-handoff` run the production graph
with real Entry, Supervisor and Capability models, plus synthetic read/verify tools. The
`context-window-handoff` case fills a bounded runtime context budget, observes
the actual budget notice and partial delivery, and checks continuation of the
same task and plan item through a fresh delegation. The
`below-watermark-control` case checks ordinary completion without a handoff.
`goal-results-verbatim` checks that the first delivery and final answer retain
the original error text needed by the current goal. Mechanical checks preserve
its punctuation and line breaks, including text inside Markdown quotations;
the independent judge checks useful results, unfinished-work boundaries and
clear technical writing. The test does not require fixed section headings or
claim full ASD-STE100 compliance.

`context-already-exceeded` returns a tool report that crosses the hard input
capacity in one step. The next child provider call must be blocked, and the
checkpoint must contain the native context guard marker. Its first attempt
must remain `missing_deliverable` with no invented handoff. The real Supervisor
then retries the same task and plan item; the fresh attempt rereads a bounded
report and completes verification. Private findings from the stopped attempt
are not replayed or promoted into a delivery.

`model-call-budget-exhausted` runs real `createSubagent` with a scaled two-call
limit. After the real final handoff response, an eval-only `afterModel` hook
requests an additional model step. The native hard guard must block that third
provider request and all further tool effects, while preserving the valid
handoff already generated. A manually driven fresh invocation receives only
that delivery and finishes the actual verification. This controlled re-entry
case checks the child lifecycle, not Supervisor scheduling. The context cases
cover the real Supervisor continuation separately. No production budget or
Supervisor prompt is changed for these fixtures.

This is separate from the existing `major-missing-work-retry` Supervisor case
and `briefing-discloses-existing-progress` subagent case: those supply partial
progress as input and do not trigger a runtime context notice. Scripted graph
regressions check the control mechanism independently of model behavior.

The handoff eval uses a scaled logical window of 16,000 tokens and synthetic
tool evidence to exercise the configured 85% policy without filling the
provider's full native window. It is not a native-window capacity or stress
benchmark. The two-call exhaustion case does not claim real-model coverage of
the default 100-call limit; scripted production graph regressions cover that
default boundary separately.

Runs default to three repeats per case. The subject uses the configured default
model profile; an independent model profile judges semantic acceptance, while
structural checks own task identity, tool effects and actual handoff evidence.
Results stay in a local report and do not require a tracing sink. The report
records model settings, production revision and harness identity. A successful
run establishes coverage at those settings, not a before/after quality gain.

Use `npm run eval:budget-handoff -- --list` to list the executable cases.
`BUDGET_HANDOFF_EVAL_PROFILE` and `BUDGET_HANDOFF_EVAL_JUDGE_PROFILE` select the
subject and independent judge; `BUDGET_HANDOFF_EVAL_CASES`,
`BUDGET_HANDOFF_EVAL_REPEATS` and `BUDGET_HANDOFF_EVAL_OUTPUT_DIR` select the
matrix and local report directory. Provider quota or judge errors are recorded
as `not_evaluable`, not as semantic passes. When reevaluating saved outputs with
an available independent judge, retain the original report and record the new
judge configuration separately without changing the acceptance criteria.
