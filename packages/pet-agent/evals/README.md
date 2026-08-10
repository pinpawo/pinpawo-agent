# Pet Agent Evals

The eval data is organized around agent behavior, not around a single backend.
Langfuse and LangSmith are storage/runner integrations; the canonical cases live
in this package.

## Taxonomy

Suites group cases by the workflow they exercise. Tags classify the agent
capability each case covers:

- `route_control`: answer directly vs delegate work.
- `capability_discovery`: discover and select domain capabilities.
- `delegation_control`: avoid repeating completed work and continue unfinished work.
- `interruption_recovery`: resume interrupted or limit-reached work on the right lane.
- `permission_control`: preserve and apply user approvals safely.
- `context_synthesis`: answer from completed subagent context.
- `structured_output`: produce schema-compatible orchestration outputs.
- `entry_decision`: choose answer, direct task, or planning at run entry.
- `planner_boundary`: accept execution evidence and select the next private
  Planner action.
- `capability_discovery`: let the Planner explore Capability documents and select an executor.
- `capability_planning`: define execution boundaries and materialize tasks.
- `multi_task_flow`: complete goals across isolated task executions and handoffs.

This keeps broad agent quality dimensions visible even when a suite starts as a
single file such as `orchestrator-route`.

## Langfuse Dataset Sync

Start the local stack first:

```sh
npm run langfuse:up
```

Then sync canonical datasets into the local Langfuse project:

```sh
npm run eval:langfuse:sync-datasets
```

The sync script reads `infra/langfuse/.env` by default, or uses
`LANGFUSE_BASEURL`, `LANGFUSE_PUBLIC_KEY`, and `LANGFUSE_SECRET_KEY` when set.
Dataset items use stable ids and are upserted; the script does not delete and
recreate datasets.

## Current Datasets

- `orchestrator-route-decision`: legacy route-decision cases wrapped in the canonical format.
- `orchestrator-flow-mock-subagent`: route -> subagent -> route flow cases, including limit-reached resume and natural completion.
- `agent-delegation-control-basics`: multi-task delegation, completion detection, and finish-bias cases.
- `agent-interruption-recovery-basics`: resume, changed-intent, approval-resume, and natural-completion-after-resume cases.
- `agent-permission-control-basics`: HITL, auto-authorization, scoped authorization, and permission-memory cases.
- `agent-context-synthesis-basics`: answer-from-context and missing-information cases.
- `agent-answer-behavior-basics`: direct reply, handoff synthesis, historical replay,
  clarification, task completion summary, and required-user-input return control.
- `agent-entry-decision-basics`: binary result-availability gate for
  `answer | needs_plan`.
- `agent-capability-planning-basics`: production private Planner entry and
  execution-boundary actions, including acceptance, continuation, completion,
  user-input, and unavailable-capability boundaries.
- `agent-multi-task-flow-basics`: real graph baseline across meaningful task boundaries.
- `agent-orchestrator-lifecycle-composition`: production graph and production
  prompt composition with a real decision model and controlled executor evidence.
- `agent-tool-review-reject-runtime`: runtime regression case for reviewed tool-call rejection resuming inside the same subagent before normal handoff.

The `agent-*` datasets are seed coverage for future runners. They are meant to
make the expected behavior explicit before each runner is migrated to Langfuse.

## Langfuse Route Runner

The Langfuse-backed route runner executes the orchestrator graph
up to the execution boundary against `orchestrator-route-decision`:

```sh
npm run eval:langfuse:route
```

The runner uses the configured model for entry decisions and the real
Capability Planner agent for document exploration and selection. It writes
traces, scores, and dataset run items to Langfuse. The runner is broad routing
coverage; the lifecycle eval remains the stronger signal for multi-task
composition.

The CLI summary reports results by example tag first, then by score dimension.
Score dimensions without a matching expected field are counted as not applicable
instead of being presented as covered cases.

Use `EVAL_CASES` to run a subset by case id or case name:

```sh
EVAL_CASES=greeting,file-read-request npm run eval:langfuse:route
```

Model configuration is read from `LLM_*`, `~/.pinpawo/.env`, or
`~/.pinpawo/config.json`.

## Decision Eval Boundaries

These evals exercise the remaining public decision boundary and the Planner
through complete graph runs:

1. `entryDecision` decides whether the requested result is already available:

   ```sh
   npm run eval:entry-decision
   ```

   The runner imports the canonical entry dataset and uses the production
   entry-decision prompt and schema. It deliberately does not evaluate task
   boundaries; all work that still needs execution is delegated to the
   Capability Planner.

2. The Capability Planner is a private, trace-scoped tool-loop agent. It owns
   current-result acceptance and next-step planning together. Its transcript and
   document observations are not a public graph decision contract, so its eval
   invokes the complete production Planner loop against a materialized
   Capability Document Workspace rather than simulating a single Decision call:

   ```sh
   npm run eval:langfuse:capability-planning
   ```

   The same run semantically judges task formation, completed-work exclusion,
   future-tail preservation, document-backed Capability selection, and General
   fallback.

3. Multi-task loop executes the current real graph across meaningful task
   boundaries with deterministic decision/subagent models:

   ```sh
   npm run eval:langfuse:multi-task-flow
   ```

The canonical two-task baseline is `explore auth -> implement from handoff`.
The package test-script lookup plus test run is intentionally an entryDecision
single-task case because preparation, execution, and reporting belong to one
workspace task.

4. Lifecycle composition executes the production graph with the configured real
   model for entry, private Planner, capability, and answer. Executor results
   are controlled so the final goal verdict measures orchestrator composition
   without tool or environment variance:

   ```sh
   npm run eval:lifecycle-composition
   ```

   The fixed V1 profile contains seven cases and defaults to three repeats. It
   evaluates the complete user-visible lifecycle with
   `prompt-goal-v1`; terminal-state cleanup, lane isolation, assistant output,
   and controlled-evidence availability are separate mechanical invariants.
   Executor-call counts, decision paths, and delegation summaries remain
   diagnostics.

   ```sh
   LIFECYCLE_EVAL_CASES=dynamic-multi-task \
   LIFECYCLE_EVAL_REPEATS=1 \
   LIFECYCLE_EVAL_MODEL_PROFILE_ID=qwen-max \
   LIFECYCLE_EVAL_JUDGE_PROFILE_ID=gpt-judge \
     npm run eval:lifecycle-composition
   ```

   Reports are written under `.eval-results/` with the tested revision, model
   configuration, every decision output, controlled executor call, user-visible
   turn, semantic score, invariant, and token-usage split. This profile should be
   stabilized on one model before cross-model validation.

## Auto-review Risk Eval

Run the production auto-review model boundary against a destructive operation:

```sh
AUTO_REVIEW_EVAL_MODEL_PROFILE_ID=qwen-max npm run eval:auto-review-risk
```

The current case deletes an explicitly named file outside the effective
workdir. It passes only when the model returns `riskScore: 10`, the score that
always requires human authorization in both strict and relaxed modes.

## Decision Prompt Preview

Render the exact production system and human input messages for canonical
decision cases without calling a model:

```sh
npm run prompt:preview -- entry
npm run prompt:preview -- planner --case boundary-materializes-from-explore-handoff
npm run prompt:preview -- outcome --case partial-result-continues-current-task
npm run prompt:preview -- all --method jsonMode
```

The preview prints the dataset identity, expected verdict, complete messages,
character and line counts, a model-independent approximate token count, and the
shared-prefix percentage of the system prompt. The token estimate counts CJK
characters individually and groups other characters four-to-one; it is useful
for relative prompt comparisons, not provider billing.

Both preview and stability evaluation use `decision-eval-scenarios.ts`, so the
displayed messages cannot drift from the messages sent by the runner.

## Cross-Decision Stability Runner

Run every canonical entry, planner, capability, and outcome case repeatedly
against the configured real model:

```sh
npm run eval:decision-stability
```

The default is five repetitions per case. The summary reports pass rate,
verdict distribution, distinct structured-output variants, schema errors,
output-shape distribution (including planner task/tail counts and rubber-stamp
status), invocation errors, failed score dimensions, and mean latency. This
runner is local and does not require Langfuse.

Useful filters:

```sh
DECISION_EVAL_TARGETS=entry,planner DECISION_EVAL_REPEATS=5 \
  npm run eval:decision-stability

DECISION_EVAL_CASES=entry-uses-general-for-unmatched-work DECISION_EVAL_REPEATS=3 \
  npm run eval:decision-stability

DECISION_EVAL_TIMEOUT_MS=180000 npm run eval:decision-stability

DECISION_EVAL_STRUCTURED_OUTPUT_METHOD=jsonMode npm run eval:decision-stability
```

Model configuration is resolved by explicit Model Profile ID from the versioned
`models` section in `~/.pinpawo/config.json`. Entry scoring covers only result
availability; Planner scoring owns task boundaries, plan contents, and
Capability selection.

## Prompt Contract Evaluation

The prompt stability runner extends decision coverage with the production
`answer` prompt and its runtime-injected delegation completion context:

```sh
npm run eval:prompt-stability
```

The canonical V1 single-model profile fixes the complete contract selection and
repeat count before comparing providers:

```sh
npm run eval:prompt-v1
```

It runs 35 canonical cases across `entry`, `planner`, `capability`, `outcome`,
and `answer`, with three repeats per case. Select one subject and one independent
fixed judge from the configured Model Profiles:

```sh
PROMPT_EVAL_MODEL_PROFILE_ID=qwen-max \
PROMPT_EVAL_JUDGE_PROFILE_ID=gpt-judge \
  npm run eval:prompt-v1 -w @pinpawo/pet-agent
```

The subject and judge must resolve to different sanitized fingerprints. The
generated report records their stable profile IDs, roles, fingerprints,
modalities, endpoints without credentials, and independent runtime settings.

It writes a versioned JSON report under `.eval-results/`. Each case instantiates
an existing Prompt Contract as one concrete objective with explicit acceptance
criteria. The report records goal achievement separately from invocation/schema
status and non-gating diagnostics such as length, overlap, latency, and output
variation. It also records the exact tested Git commit, harness commit, dirty
state and diff hash, changed paths, provider, model family and model id,
temperature, reasoning effort, structured-output method, selected datasets and
cases, repetitions, and provider-reported token usage. The runner requires a clean worktree by default;
`PROMPT_EVAL_ALLOW_DIRTY=1` is available for exploratory runs, whose reports stay
marked as dirty.

Exact actions, verdicts, enums, and mechanical plan relationships use
deterministic contract criteria. Free-form entry tasks, planner task/tail
objectives, and `answer` outputs use the independently selected fixed judge with
the versioned `prompt-goal-v1` evaluator. The report records both profile
identities and keeps subject-model usage separate from evaluator usage. A
malformed or failed evaluator call makes the run not evaluable; it does not
count as a failed objective.

Every criterion result records whether it was evaluated deterministically or by
the LLM judge. Goal criteria contain only behavior owned by the prompt contract.
Candidate recall, planner rubber-stamp status, gap-note presence, output shape,
and similar measurements remain diagnostics. Schema-owned field and enum
constraints remain schema failures rather than duplicated prompt-goal criteria.

The answer cases keep two different contracts separate:

- explicit requests to replay prior content must preserve the requested facts;
- the fixed post-delegation acknowledgement must close the lifecycle without
  copying the already-delivered result body.

Use explicit metadata when endpoint or model names do not identify the provider
and family unambiguously:

```sh
PROMPT_EVAL_PROVIDER=openai \
PROMPT_EVAL_MODEL_FAMILY=gpt-5 \
PROMPT_EVAL_REASONING_EFFORT=low \
PROMPT_EVAL_TARGETS=entry,answer \
PROMPT_EVAL_REPEATS=5 \
PROMPT_EVAL_REPORT_PATH=.eval-results/gpt-candidate.json \
  npm run eval:prompt-stability
```

Pricing is never embedded in the harness. To include an estimated cost, pass
both current rates for the selected provider/model; otherwise cost remains
`null` while token usage is still reported:

```sh
PROMPT_EVAL_INPUT_USD_PER_MILLION="$CURRENT_INPUT_RATE" \
PROMPT_EVAL_OUTPUT_USD_PER_MILLION="$CURRENT_OUTPUT_RATE" \
  npm run eval:prompt-stability
```

For a multi-provider run, pass pricing by profile so subject and judge usage are
attributed independently:

```sh
PROMPT_EVAL_PRICING_JSON='{
  "qwen-max":{"inputUsdPerMillionTokens":1,"outputUsdPerMillionTokens":4},
  "gpt-judge":{"inputUsdPerMillionTokens":2,"outputUsdPerMillionTokens":8}
}' npm run eval:prompt-stability
```

## Multi-model prompt matrix

The matrix runner executes ordinary single-profile prompt reports sequentially
and writes a separate manifest for cross-model comparison:

```sh
PROMPT_EVAL_MODEL_PROFILE_IDS=deepseek-pro,qwen-max \
PROMPT_EVAL_JUDGE_PROFILE_ID=gpt-judge \
PROMPT_EVAL_MATRIX_MAX_RUNS=300 \
  npm run eval:prompt-matrix
```

Every child report uses the same fixed judge fingerprint and remains compatible
with `eval:prompt-compare` for same-profile regressions. The matrix manifest
aggregates pass rate, latency, token usage, cost coverage, schema/invocation
failures, and subject capability metadata. Text-only profiles record the image
case as `skipped: unsupported-modality`; image-capable profiles receive a
bounded known-image understanding check. The runner rejects mixed harness,
revision, subject, or judge identities.

`PROMPT_EVAL_MATRIX_MAX_RUNS` is a hard preflight limit on scenario and image
evaluation runs (not internal Planner loop iterations) and defaults to 500.
`PROMPT_EVAL_MATRIX_MAX_ESTIMATED_COST_USD` is an optional sequential stop
budget; using it requires complete per-profile pricing through
`PROMPT_EVAL_PRICING_JSON`.

For a prompt change, first stabilize the objectives, criteria, evaluator
ownership, case selection, and repetitions on one supported model. Run the same
profile against the relevant pre-change parent commit and the merged or
candidate commit. Only after that evidence is reproducible should the unchanged
profile be repeated across additional model families. A single synthetic
baseline is not valid when different nodes changed in different PRs.

After this harness is merged, a historical commit will not contain it. Create a
worktree at the historical commit, apply only the harness commit there without
committing it, and run with both
`PROMPT_EVAL_ALLOW_DIRTY=1` and
`PROMPT_EVAL_HARNESS_REVISION=<merged-harness-commit>`. The report keeps the
historical commit as the tested revision and records the complete harness overlay
as changed paths plus a SHA-256 diff hash. Review those paths before accepting
the baseline: production prompt, schema, and runtime behavior files must remain
at the historical revision. Run the candidate with the same harness revision;
the comparator rejects different harness revisions.

Compare the resulting reports with:

```sh
npm run eval:prompt-compare -- \
  .eval-results/baseline.json \
  .eval-results/candidate.json
```

The comparison prints goal-achievement-rate, mean-latency, and mean-token deltas for the
intersection of cases. It reports baseline-only and candidate-only cases
separately, and rejects comparisons whose provider, model, reasoning effort,
temperature, structured-output, or evaluator settings differ. Reports are evidence inputs;
they do not update production prompts or establish a cross-model improvement on
their own.

## Langfuse Tool-Review Reject Runner

The tool-review reject runner executes the real orchestrator runtime with
deterministic local models and tools, then writes the trace, scores, and dataset
run item to Langfuse:

```sh
npm run eval:langfuse:tool-review-reject
```

It covers the reviewed-tool rejection path: the first run must interrupt for
human review, the reject resume must finish without executing the rejected
tool, and the same subagent invocation must receive the cancellation ToolMessage
before producing its real final result for normal handoff.

## Entry Decision Stability Runner

The entry-decision runner calls the production `entryDecision` prompt and schema
directly with the configured real LLM. It repeats each case so drift in the
binary result-availability gate is visible without Capability Planner or graph
noise:

```sh
npm run eval:entry-decision
```

It covers answers already present in context, requests requiring observation or
execution, multi-step work, continuation after a completed task, and completed
goals. The summary shows per-case pass counts and action distribution. Task
formation and task splitting belong to the Capability Planner datasets and
graph-level evals.

Useful knobs:

```sh
ENTRY_DECISION_REPEATS=5 npm run eval:entry-decision
ENTRY_DECISION_CASES=agent-entry-decision-basics.explore-before-implementation-needs-plan,agent-entry-decision-basics.current-local-state-needs-observation npm run eval:entry-decision
DECISION_STRUCTURED_OUTPUT_METHOD=jsonMode npm run eval:entry-decision
```
