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
- `agent-tool-review-reject-runtime`: runtime regression case for reviewed tool-call rejection stopping subagent execution and handing off the cancellation announce.

The `agent-*` datasets are seed coverage for future runners. They are meant to
make the expected behavior explicit before each runner is migrated to Langfuse.

## Langfuse Route Runner

The first Langfuse-backed runner executes the real orchestrator route graph
against `orchestrator-route-decision`:

```sh
npm run eval:langfuse:route
```

By default, this uses a local deterministic route model so it can run without
sending eval cases to an external LLM. It still executes the real orchestrator
graph and writes traces, scores, and dataset run items to Langfuse.

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
TASK_DECISION_CASES=initial-multi-step-investigation,post-first-no-draft npm run eval:task-decision
DECISION_STRUCTURED_OUTPUT_METHOD=jsonMode npm run eval:task-decision
```
