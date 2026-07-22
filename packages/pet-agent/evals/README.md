# Pet Agent Evals

The eval data is organized around agent behavior, not around a single backend.
Langfuse and LangSmith are storage/runner integrations; the canonical cases live
in this package.

## Taxonomy

Suites group cases by the workflow they exercise. Tags classify the agent
capability each case covers:

- `route_control`: answer directly vs delegate work.
- `capability_search`: discover and select domain capabilities.
- `delegation_control`: avoid repeating completed work and continue unfinished work.
- `interruption_recovery`: resume interrupted or limit-reached work on the right lane.
- `permission_control`: preserve and apply user approvals safely.
- `context_synthesis`: answer from completed subagent context.
- `structured_output`: produce schema-compatible orchestration outputs.
- `entry_decision`: choose answer, direct task, or planning at run entry.
- `capability_decision`: search and select the capability for a current task.
- `outcome_decision`: accept the announce and select the next transition.
- `capability_planning`: define capability execution boundaries and materialize tasks.
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
- `agent-capability-search-basics`: basic capability discovery and capability-vs-general routing cases.
- `agent-delegation-control-basics`: multi-task delegation, completion detection, and finish-bias cases.
- `agent-interruption-recovery-basics`: resume, changed-intent, approval-resume, and natural-completion-after-resume cases.
- `agent-permission-control-basics`: HITL, auto-authorization, scoped authorization, and permission-memory cases.
- `agent-context-synthesis-basics`: answer-from-context and missing-information cases.
- `agent-answer-behavior-basics`: direct reply, handoff synthesis, historical replay,
  clarification, and fixed completion-acknowledgement behavior.
- `agent-entry-decision-basics`: eval contract for `answer | direct_task | needs_plan`.
- `agent-capability-decision-basics`: end-to-end capability search and selection from a current task.
- `agent-outcome-decision-basics`: `continue | task_done | goal_done` verdict boundaries.
- `agent-capability-planning-basics`: production `planner@entry` and `planner@boundary` contracts.
- `agent-multi-task-flow-basics`: real graph baseline across meaningful task boundaries.
- `agent-tool-review-reject-runtime`: runtime regression case for reviewed tool-call rejection stopping subagent execution and handing off the cancellation announce.

The `agent-*` datasets are seed coverage for future runners. They are meant to
make the expected behavior explicit before each runner is migrated to Langfuse.

## Langfuse Route Runner

The legacy Langfuse-backed route snapshot runner executes the orchestrator graph
up to the execution boundary against `orchestrator-route-decision`:

```sh
npm run eval:langfuse:route
```

By default, this uses a local deterministic route model so it can run without
sending eval cases to an external LLM. It still executes the real orchestrator
graph and writes traces, scores, and dataset run items to Langfuse.

This runner is retained as broad graph-plumbing regression coverage. It does
not prove task text quality, capability search query quality, or a complete
multi-task execution loop.

Because capability search candidates are now local to `capabilityDecision`
rather than graph state, this legacy runner scores route/mode/phase, active
capability, and finish/delegate behavior. Candidate recall and search-query
quality are covered by `eval:langfuse:capability-decision` instead.

The CLI summary reports results by example tag first, then by score dimension.
Score dimensions without a matching expected field are counted as not applicable
instead of being presented as covered cases.

Use `EVAL_CASES` to run a subset by case id or case name:

```sh
EVAL_CASES=greeting,file-read-request npm run eval:langfuse:route
```

To run the same route eval with the configured LLM instead of the local
deterministic model, set `EVAL_ROUTE_MODEL=llm`. LLM mode reads configuration
from `LLM_*`, `~/.pinpawo/.env`, or `~/.pinpawo/config.json`.

## Decision Eval Boundaries

These evals exercise the production Phase 2 decision contracts:

1. `entryDecision` chooses `answer | direct_task | needs_plan`:

   ```sh
   npm run eval:task-decision
   ```

   The runner imports the canonical entry dataset and uses the production
   entry-decision prompt and schema.

2. `capabilityDecision` starts from an already-defined current task and evaluates
   candidate recall plus final custom/general selection. Candidate search and
   selection are one production graph node:

   ```sh
   npm run eval:langfuse:capability-decision
   ```

   The default is deterministic and validates dataset/search/route plumbing.
   Use the production decision model to evaluate the route prompt itself:

   ```sh
   EVAL_CAPABILITY_MODEL=llm npm run eval:langfuse:capability-decision
   ```

3. `outcomeDecision` has a standalone canonical dataset for current-task
   acceptance. `task_done` deliberately leaves next-task planning to
   `planner@boundary`:

   ```sh
   npm run eval:langfuse:outcome-decision
   EVAL_OUTCOME_MODEL=llm npm run eval:langfuse:outcome-decision
   ```

4. `capabilityPlanner` cases are split into `planner@entry` and
   `planner@boundary`. They define plan creation, materialization, cancellation,
   and rubber-stamp expectations. The runner imports the production planner
   prompt and schema:

   ```sh
   npm run eval:langfuse:capability-planning
   EVAL_PLANNER_MODEL=llm npm run eval:langfuse:capability-planning
   ```

5. Multi-task loop executes the current real graph across meaningful task
   boundaries with deterministic decision/subagent models:

   ```sh
   npm run eval:langfuse:multi-task-flow
   ```

The canonical two-task baseline is `explore auth -> implement from handoff`.
The package dependency plus test request is intentionally an entryDecision
single-task case because both actions can be completed naturally in one
workspace capability execution.

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

DECISION_EVAL_CASES=boundary-cancels-obsolete-task DECISION_EVAL_REPEATS=3 \
  npm run eval:decision-stability

DECISION_EVAL_TIMEOUT_MS=180000 npm run eval:decision-stability

DECISION_EVAL_STRUCTURED_OUTPUT_METHOD=jsonMode npm run eval:decision-stability
```

Model configuration is resolved from `LLM_*`, then `~/.pinpawo/.env`, then
`~/.pinpawo/config.json`. Entry scoring covers mode and direct-task content;
planner scoring owns plan boundary count and plan contents.

## Cross-Model Prompt Evaluation

The prompt stability runner extends decision coverage with the production
`answer` prompt and its runtime-injected delegation completion context:

```sh
npm run eval:prompt-stability
```

It writes a versioned JSON report under `.eval-results/`. Each report records the
exact tested Git commit, harness commit, dirty state and diff hash, changed paths,
provider, model family and model id,
temperature, reasoning effort, structured-output method, selected datasets and
cases, repetitions, semantic scores, schema/invocation failures, latency, and
provider-reported token usage. The runner requires a clean worktree by default;
`PROMPT_EVAL_ALLOW_DIRTY=1` is available for exploratory runs, whose reports stay
marked as dirty.

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

For a prompt change, run the same target, cases, model settings, and repetitions
against the relevant pre-change parent commit and the merged or candidate commit.
Do this separately for at least two supported model families when access permits.
A single synthetic baseline is not valid when different nodes changed in
different PRs.

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

The comparison prints pass-rate, mean-latency, and mean-token deltas for the
intersection of cases. It reports baseline-only and candidate-only cases
separately, and rejects comparisons whose provider, model, reasoning effort,
temperature, or structured-output settings differ. Reports are evidence inputs;
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
human review, the reject resume must finish without executing or retrying the
tool, and the cancellation announce must be handed off into main messages.

## Task Decision Stability Runner

The task-decision runner calls the production `taskDecision` prompt and schema
directly with the configured real LLM. It repeats each case so prompt drift is
visible without subagent or graph noise:

```sh
npm run eval:task-decision
```

It covers direct answer, single delegated task, multi-step investigation,
PR review keywords, task continuation from completed summaries, and completed-goal
answer. The summary shows per-case pass counts, action distribution, and task output
distribution.

Useful knobs:

```sh
TASK_DECISION_REPEATS=5 npm run eval:task-decision
TASK_DECISION_CASES=agent-entry-decision-basics.explore-before-implementation-needs-plan,after-first-handoff-remaining-work npm run eval:task-decision
DECISION_STRUCTURED_OUTPUT_METHOD=jsonMode npm run eval:task-decision
```
