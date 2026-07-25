# CapabilityPlanner Task-Horizon Draft

Status: experimental. This document is outside the wiki and does not define an
accepted runtime contract. Ingest only after the planner design and real-model
eval profile are accepted.

## Problem

`capabilityPlanner` receives a user goal at one of two moments:

- `entry`: execution has not started;
- `boundary`: one task has produced a handoff and future work must be
  reconsidered.

Its problem is not to predict every future action. It must preserve the whole
goal while distinguishing:

- work that is sufficiently determined to execute and verify now;
- future work whose purpose is known even when its details depend on a result
  that does not yet exist;
- work that a new result has made unnecessary.

The current prompt describes this mainly through `mode` and whether one
capability can perform related actions. That is operationally useful, but it
does not state the planning boundary itself.

## Planning view

A plan is the current expression of commitments across result boundaries.

- `next_task` is the one commitment whose objective can be executed and
  verified with the results available now.
- `remaining_plan` preserves later commitments without presenting them as
  current work.
- A handoff changes the available results. Boundary planning therefore
  re-evaluates the future rather than mechanically advancing an old list.
- Completed tasks and their result summaries are immutable facts supplied to
  the planner; they are not regenerated as plan output.

Task boundaries follow independently verifiable results. Several actions belong
to one task when they jointly produce one result; the boundary does not depend
on how many verbs the request contains.

## Ownership

The planner owns:

- the current task objective;
- future task boundaries and order;
- cancellation or revision of future work after a handoff;
- a short `capability_intent` describing the kind of ability a task needs.

`capabilityDecision` owns the concrete executor choice. The planner receives a
capability registry as context about available ability types, but
`capability_intent` is not a registry ID contract.

The graph owns the mechanical mapping:

- `next_task` to the pending task;
- `remaining_plan` to the future tail;
- `answer` to an empty current task and empty tail.

## Candidate decision

### Entry

Start from the complete user goal:

1. Form the first objective that can be executed and verified now.
2. Preserve later independently verifiable work in goal order.
3. Preserve the purpose of later work without inventing details that require a
   future result.

### Boundary

Start from the complete user goal, completed task facts, the latest handoff,
and the unstarted tail:

1. Treat the handoff as the result of the task that just ended.
2. Re-evaluate whether each future commitment is still required.
3. Materialize the first required objective that can now be executed and
   verified.
4. Preserve only the later work that still belongs to the goal.
5. Return `answer` when no autonomous work remains.

The production prompt should state this boundary compactly. Output shape,
required fields, and empty-plan invariants remain schema responsibilities.

## Eval corrections

The current canonical cases cover useful temporal transitions:

- entry exploration followed by future implementation;
- handoff-driven materialization;
- cancellation after a successful verification;
- preservation of an already valid next task;
- materialization of a head while preserving a later tail;
- grouping related actions into one result boundary.

The scorer currently requires `capability_intent` and every future intent to
equal a registry-style string exactly. That exceeds the planner contract.
Evaluation should instead require:

- exact `result` and schema-valid current/future separation;
- goal-based evaluation of current and future objectives in execution order;
- semantic justification of task boundaries, allowing more than one valid
  decomposition of the same goal;
- semantic compatibility of each `capability_intent` with its task;
- executor identity and candidate selection only in the
  `capabilityDecision` contract.

Natural-language cases should avoid revealing the expected task split through
an artificial step list. Paired cases should distinguish one jointly verifiable
result from multiple or result-dependent commitments.

## Candidate v1

The first candidate applied the task-horizon boundary without changing the
then-current planner schema:

- production wording now groups work by one independently verifiable result
  rather than by one named capability;
- boundary mode treats the latest handoff as a new result and explicitly
  supports materialization, revision, preservation, and cancellation;
- `capability_intent` is stated as an ability description owned separately from
  executor selection;
- deterministic scoring retains result, task order/count, and dependency
  status, while objectives and capability intents are judged semantically;
- the former single-task planner-entry case is replaced by a real multi-boundary
  goal whose issue update depends on the test result;
- registry fixtures include capability descriptions instead of bare IDs.

Local evidence for this candidate:

- pet-agent TypeScript and eval TypeScript checks pass;
- 37 focused planner/scorer/prompt/schema tests pass;
- the full pet-agent suite passes with 304 tests;
- representative entry and boundary production messages render without
  unresolved template fields;
- the planner system message is 674 characters and 22 lines before a
  provider-specific output instruction.

## Experiment log

Candidates v1-v10 used the historical `concrete | deferred` future-task status.
Candidate v11 removes that unused output dimension and is the current design.

1. Candidate v1 ran the six-case GLM-5.2 planner profile three times with the
   production `jsonMode` method. It achieved 11/18 goals; two additional runs
   were not evaluable because the judge timed out. There were no subject-model
   schema or invocation errors.
2. All evaluable failures shared one behavior. The model promoted internal
   design or verification work into additional deferred tasks:
   - entry exploration produced separate design, implementation, and sometimes
     verification tails;
   - boundary materialization produced implementation as `next_task` and
     verification as a new tail.
3. Cancellation, preservation of a concrete task, materialization while
   preserving an independent release tail, and a result-dependent issue update
   all passed every evaluable run.
4. Candidate v2 defines a task boundary by control returning to the planner:
   a new task is formed when one result must arrive before later work can be
   determined. Intermediate results used only to complete the same objective
   remain inside that task. The schema and eval cases are unchanged.
5. A targeted v2 rerun achieved 4/6 under the existing scorer. The boundary
   case stopped adding a verification tail in all three runs. The entry case
   still split internal design from implementation twice; the third run kept
   only a design tail, which the objective judge incorrectly accepted as the
   requested refactor.
6. Candidate v3 defines a task by the result the user asked to receive. Internal
   judgment and verification belong to that result; a new boundary exists only
   when one delivered result determines whether or how another independently
   requested result should continue. The objective judge also requires the
   actual requested outcome, so an intermediate plan cannot substitute for a
   requested change.
7. Candidate v3 still produced an exploration task followed by separate design
   and implementation tasks in all three targeted runs. This shows that a
   user-facing deliverable alone does not define the runtime boundary:
   exploration may need its own ability and handoff even though it is not the
   final deliverable.
8. Candidate v4 defines a task as one continuous execution that one ability can
   use to produce a jointly verifiable result. Stages chosen inside that
   execution stay inside the task. A new boundary is formed when later work
   must wait for the task result or another ability must execute independently.
9. Candidate v4 still split design from implementation in both evaluable
   targeted runs; the third judge call timed out after the subject completed.
   The model interpreted an internal design result as a result that later work
   must wait for.
10. Candidate v5 maps the boundary to the runtime transition directly. Adjacent
    work performed continuously by one ability is one objective. A new task is
    formed when the ability changes, or when the previous result must return as
    `latest_handoff` before continuation can be decided.
11. Candidate v5 achieved 1/3 in the targeted entry case. The successful run
    merged solution design, code change, and verification into one deferred
    `general` task. The other two runs first split design and implementation,
    then assigned both the same ability without merging them.
12. Candidate v6 changes no planning concept. It makes grouping precede output
    construction: identify and merge continuous work by `capability_intent`,
    then determine `next_task` and `remaining_plan`.
13. Candidate v6 still failed both evaluable targeted runs; one judge call
    timed out. Across candidates, the model consistently treated the word
    "solution" in the user goal as a separately requested deliverable. That
    interpretation is reasonable, so the case did not isolate the intended
    planning behavior.
14. Candidate v7 states the same ability boundary compactly and rewrites the
    case goal to require a completed repository change whose details must be
    grounded in the current structure and risks. It does not reveal the task
    sequence; it removes an unintended second deliverable from the request.
15. Candidate v7 achieved 2/3. The remaining failure separated verification
    from the code change even though both used the same `general` ability. The
    prompt had required only the current task, not every future task, to be
    independently verifiable.
16. Candidate v8 applies one definition to every task: one ability executes
    continuously until it produces a verifiable result. `next_task` is simply
    the first such task that current results make executable.
17. Candidate v8 initially achieved 3/3 in the targeted entry case. After the
    judge wording was generalized, the same subject prompt achieved 2/3. The
    failed run added an independent verification task with the same `general`
    ability. Its failure was deterministic task count, so the judge wording did
    not cause the regression; the subject behavior remained unstable.
18. Candidate v9 keeps decision semantics in the system prompt and field
    semantics in the schema. A task includes the work needed to reach its
    verifiable result. `remaining_plan` is defined as future work from the user
    goal that still requires independent execution, rather than work the
    planner invents as an internal quality stage.
19. Candidate v9 produced one evaluable targeted run, which passed, and two
    judge timeouts. All three subject calls completed without schema or
    invocation errors, but the runner does not retain subject output when the
    judge times out. This is insufficient evidence for stability.
20. Candidate v10 removes "commitment" from production language and restores
    purpose before mechanism. A task produces one verifiable result. Ability
    continuity determines which work can stay within that result boundary;
    dependency, a different independently executing ability, or a separate
    purpose-relevant acceptance result can justify another task. A dependency
    crosses the boundary only when the previous task must return its result
    before later work can be determined. Schema wording now says work is needed
    to achieve the user goal rather than literally contained in the user's
    request. Evaluation permits necessary instrumental objectives while
    requiring the plan as a whole to preserve the ultimate outcome.
21. Candidate v10 ran the complete six-case GLM-5.2 planner profile three
    times. It achieved 14/18 goals; one additional run was not evaluable because
    the judge emitted malformed JSON. There were no subject schema or invocation
    errors. Three behavior failures remained:
    - the handoff-materialization case split verification from the code change
      into a new future task in two of three runs;
    - the materialized-head case preserved release verification but marked it
      `concrete` once even though the current code change had not returned yet.
    Cancellation, concrete-tail preservation, and the result-dependent issue
    update were stable at 3/3. The difficult entry exploration case passed both
    evaluable runs.
22. Candidate v11 separates immutable execution facts from mutable future
    planning. Boundary input now includes every completed task objective and
    result summary in the run, plus the full latest handoff and the unstarted
    tail. The planner continues to own semantic revisions to `next_task` and
    `remaining_plan`; runtime only preserves facts and maps output.
23. Candidate v11 removes `concrete | deferred` from the production schema,
    runtime plan state, and eval contract. Runtime never consumed the status,
    while the position of `next_task` and `remaining_plan` already expresses
    the temporal boundary. Result-dependent future work retains its purpose in
    the objective and is reconsidered when a result arrives.
24. Candidate v11 achieved 15/18 goals in the full three-repeat GLM-5.2
    profile, with one judge timeout. All five cases that exercised completed
    facts, handoff integration, cancellation, preservation, and a
    result-dependent follow-up passed 3/3. The remaining entry case split
    design, implementation, and verification into multiple future tasks even
    though the same ability would execute them continuously.
25. Candidate v12 describes the runtime boundary directly: a task continues
    until one ability returns a useful result, and the stages that ability
    arranges internally remain within the task. A new task begins when later
    work must wait for that returned result before it can be decided, or when a
    different ability must execute it.
26. Candidate v12 targeted the difficult entry case for three repeats. One run
    used a single future refactor task, one split implementation and
    post-change verification, and one judge call timed out. The semantic judge
    explicitly accepted both decompositions as goal-preserving; the split run
    failed only because the deterministic scorer required exactly one future
    task.
27. Exact future-task count is therefore removed from the gating contract.
    Schema owns current/future output structure, the goal judge evaluates
    whether every boundary preserves and reasonably decomposes the goal, and
    task count remains a shape diagnostic. This matches the accepted principle
    that an independently meaningful verification boundary can be reasonable.
28. With the corrected contract, the difficult GLM-5.2 entry case achieved 3/3
    goals. All subject outputs were schema-valid and all judge calls completed.
    The model produced two or three future tasks across runs; each variant
    preserved the refactor goal and used semantically justified boundaries.
29. The complete six-case, three-repeat final profile produced 18/18
    schema-valid subject outputs. All 17 evaluable judge results achieved their
    goals; the final judge request for the result-dependent issue follow-up
    timed out. That timeout is not a behavior failure, so one supplemental
    evaluable run is still required for final acceptance.
30. The supplemental result-dependent follow-up run achieved its goal with no
    schema, invocation, or evaluation error. Combined with the full profile,
    every case now has three evaluable passing results: final acceptance is
    18/18.
31. Review found that the legacy Langfuse planner runner still called the
    deterministic result scorer directly in LLM mode. The planner goal contract
    and semantic evaluator are now shared by both runners. A regression test
    confirms that a correct `result` does not pass when the produced plan loses
    the user's objective.

## Acceptance before wiki ingestion

- Entry preserves the complete user goal across current and future tasks.
- Boundary uses completed task facts and the latest handoff to materialize,
  revise, preserve, or cancel future work.
- `next_task` is executable and independently verifiable with current results.
- Future work retains its required purpose without inventing result-dependent
  details.
- `remaining_plan` contains only unstarted work after `next_task`.
- `capability_intent` remains an ability description rather than an executor
  selection.
- The fixed GLM-5.2 planner profile is stable across three repetitions.
- Local type checks, contract tests, and the full pet-agent test suite pass.
