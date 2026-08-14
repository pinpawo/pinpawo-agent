# Studio Run Controller PR Design Adjustments

> **Status: historical record.** This page preserves earlier design or implementation context; it does not define current behavior. Start with [the current documentation map](../../index.md).

本文记录 Studio Run Controller 重做过程中,每个迭代 PR 对设计做出的调整。

## Branch `codex/studio-run-controller-redesign`

- Date: 2026-06-20
- Iteration: 8
- Design adjustment: Iteration 8 is split into scheduler-entry persistence, an independent Studio run/queue store, and conservative orchestrator recovery. The current branch records due-run requests, workdir claims, attempts, trace, metrics, and `finalPetRunId`; it also adds `StudioRunQueueStore` / `FileStudioRunQueueStore` for Studio run snapshots and task queue items, wires the store into `createStudioOrchestrator`, and uses a workdir-scoped file store in local Studio runtime.
- Reason: due-run persistence is an external request scheduler concern. Reusing it as the Studio task queue would violate the design boundary; internal queued task recovery needs its own store. Running task recovery must be conservative so restart does not duplicate worker handoffs.
- Affected docs: `../../studio/run-controller.md`, `../../studio/run-controller-iteration-plan.md`
- Follow-up: add a richer reconcile/resume strategy for tasks that were already handed off to a pet before process restart.

- Date: 2026-06-20
- Iteration: 9
- Design adjustment: FIFO admission was clarified for default `deps = []`: the runner only considers the earliest `queued` task; once prior queue items have been handed off to pets, a no-deps task may be handed off immediately when its target pet is idle.
- Reason: queue ordering should stay simple. Default no-deps tasks depend on handoff order, not completion; explicit deps are the only mechanism that waits for earlier task completion.
- Affected docs: `../../studio/run-controller.md`
- Follow-up: keep cross-run fairness and timeout/migration policies out of this iteration.

- Date: 2026-06-20
- Iteration: 4 / 7
- Design adjustment: canonical async Studio API is `submitRequest()` + `waitForRun()` / `getRun()` / `subscribe()`. Legacy `enqueue()` / `subscribeEvents()` / `invoke()` aliases were removed from the public `StudioOrchestrator` API after local callers and tests migrated.
- Reason: the redesign explicitly says Studio should not use synchronous `invoke()` as the primary API. Keeping aliases after migration would preserve the old Studio turn entrypoint as a supported surface.
- Affected docs: `../../studio/run-controller.md`, `../../studio/run-controller-iteration-plan.md`
- Follow-up: none for the aliases.

- Date: 2026-06-20
- Iteration: 3 / 4
- Design adjustment: public `submitRequest()` input no longer accepts a first-class `plan`; the input type is now `StudioSubmitRequestInput`, and planner-driven `enqueue_tasks` is the only runtime path for task creation.
- Reason: keeping `plan` on the request API let callers bypass the planner capability and preserved the old first-class plan model at the Studio boundary.
- Affected docs: `../../studio/run-controller.md`, `../../studio/run-controller-iteration-plan.md`
- Follow-up: none in runtime; orchestrator tests that need deterministic task plans now use a planner stub that calls `studio_plan.enqueue_tasks`.

- Date: 2026-06-20
- Iteration: 5 / 6
- Design adjustment: run terminal outcome is now derived from task queue items and their `petRunId`/task result.
- Reason: canonical design treats task queue item as the Studio-owned worker shell and pet run as the execution fact; `StudioDispatch` should not decide run completion.
- Affected docs: `../../studio/run-controller.md`
- Follow-up: remove legacy `finalDispatchId` row compatibility after old due-run persistence files are no longer supported.

- Date: 2026-06-20
- Iteration: 8
- Design adjustment: due-run persistence and trace now store `finalPetRunId` as the completed-run identity. Old persisted rows with only `finalDispatchId` are backfilled into `finalPetRunId` on read.
- Reason: scheduler entry should submit Studio requests and record the resulting pet run identity, not preserve Studio dispatch as a first-class concept.
- Affected docs: `../../studio/run-controller.md`, `../../studio/run-controller-iteration-plan.md`
- Follow-up: remove legacy `finalDispatchId` row compatibility after old due-run persistence files are no longer supported.

- Date: 2026-06-20
- Iteration: 7 / 8
- Design adjustment: local-agent protocol and HTTP trace tests now treat `finalPetRunId` as the Studio completion identity.
- Reason: external control surfaces should align with the canonical task/pet-run model before `StudioDispatch` is removed from the Studio runtime.
- Affected docs: `../../studio/run-controller.md`
- Follow-up: keep parser tolerant of old inbound `finalDispatchId` payloads only where that costs no runtime state.

- Date: 2026-06-20
- Iteration: 4 / 5
- Design adjustment: FIFO admission is non-blocking after handoff. The runner only considers the earliest `queued` task; when its `deps` are empty, all previous queue items have already been handed to pets, and the target pet is idle, the task is handed to that pet immediately.
- Reason: the queue coordinates when Studio may start worker tasks; it should not serialize independent tasks by waiting for previously handed-off workers to finish.
- Affected docs: `../../studio/run-controller.md`, `../../studio/run-controller-iteration-plan.md`
- Follow-up: keep worker completion handling limited to task/wiki updates plus another runner check.

- Date: 2026-06-20
- Iteration: 5
- Design adjustment: `ExecuteAction` is no longer exported as a Studio public type; the runner keeps only an internal dispatch input for the worker handoff.
- Reason: the redesign removes `ExecuteAction` as an architecture concept. Finish/stop outcomes are derived from run/task state, not modeled as public execute actions.
- Affected docs: `../../studio/run-controller.md`
- Follow-up: keep legacy due-run row backfill isolated to persistence reading.

- Date: 2026-06-20
- Iteration: 5 / 6
- Design adjustment: `StudioDispatchState`, `StudioDispatchStatus`, `StudioTurnState.dispatches`, and `StudioRunSnapshot.dispatches` were removed. Worker handoff keeps only the task queue item plus `petRunId`.
- Reason: Studio should not mirror worker execution facts in a separate dispatch read model. The task queue item is Studio's shell state, and the pet runtime owns execution details.
- Affected docs: `../../studio/run-controller.md`
- Follow-up: `task_started` / `task_finished` remain local progress events for TUI/server bridges; canonical external state stays `run_changed` / `wiki_changed`.

- Date: 2026-06-20
- Iteration: 6 / 8
- Design adjustment: Studio runtime outcomes, run snapshots, local-agent `studio_response`, due-run trace, and scheduler completions no longer expose `finalDispatchId`; `finalPetRunId` is the only completed worker identity emitted by new code.
- Reason: `finalDispatchId` preserved the removed `StudioDispatch` model. Keeping it in outward payloads would keep the old concept alive even after task queue items became the authoritative Studio shell state.
- Affected docs: `../../studio/run-controller.md`
- Follow-up: legacy due-run rows may still contain `finalDispatchId`; file store read compatibility backfills it into `finalPetRunId` until old persistence files can be dropped.

- Date: 2026-06-20
- Iteration: 7
- Design adjustment: legacy local progress events `dispatch_started` / `dispatch_finished` were renamed to `task_started` / `task_finished`, and their identity field is now `petRunId`.
- Reason: the dispatch read model has been removed; local progress should describe task handoff and pet run identity without reintroducing `StudioDispatch` terminology.
- Affected docs: `../../studio/run-controller.md`
- Follow-up: `StudioTurnEvent` remains a local progress stream for TUI/server bridges; canonical external Studio events stay `run_changed` / `wiki_changed`.

- Date: 2026-06-20
- Iteration: 4 / 7
- Design adjustment: `StudioRunSnapshot.plan` was removed. Run snapshots expose the worker task queue directly through `tasks`; any plan/audit view should be derived from those task items.
- Reason: the redesign removes first-class `StudioTaskPlan` as public run state. Keeping `plan` in snapshots duplicated the task queue and kept the old planning model visible.
- Affected docs: `../../studio/run-controller.md`
- Follow-up: `StudioTaskPlan` and `StudioTaskRuntimeState` are no longer shared Studio types or package exports. Runtime normalization now uses an internal queued task batch and internal runtime bookkeeping.

- Date: 2026-06-20
- Iteration: 4 / 7
- Design adjustment: local progress event `plan_set` was replaced with `tasks_queued { taskCount }`.
- Reason: `plan_set` exposed a first-class plan object through the progress stream. The canonical Studio surface should expose queue/run state, while task creation remains planner-driven through `enqueue_tasks`.
- Affected docs: `../../studio/run-controller.md`
- Follow-up: `StudioTurnEvent` remains a local bridge progress stream; canonical external state is still `run_changed` / `wiki_changed`.

- Date: 2026-06-20
- Iteration: 4 / 7
- Design adjustment: `StudioTurnResult.state` and the exported `StudioTurnState` type were removed. `StudioTurnResult` now returns `snapshot`, `outcome`, and `studio`; task status is read from `snapshot.tasks`.
- Reason: public turn state duplicated the queue and exposed internal runner bookkeeping (`taskStates`, `iterationCount`, `wikiRoot`) that is not part of the canonical Studio API.
- Affected docs: `../../studio/run-controller.md`
- Follow-up: internal runner state remains private inside `createStudioOrchestrator`.

## Template

```md
## PR #<number or branch>

- Date:
- Iteration:
- Design adjustment:
- Reason:
- Affected docs:
- Follow-up:
```
