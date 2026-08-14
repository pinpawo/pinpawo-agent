# Studio Run Controller Iteration Plan

> **Status: historical.** This delivery plan targets the removed pull-model
> `StudioOrchestrator`; it does not describe the current Studio contract.
> See the [current Studio documentation](../../studio/index.md).

本文描述 `run-controller.md` 的重做迭代。目标是先清理旧概念,再按可验证的小步重建 Studio runtime。

每个迭代 PR 如产生设计调整,记录到 `../history/studio/run-controller-pr-adjustments.md`。

原则:

- 不以兼容旧 Studio 内部模型为目标。
- 每一步都能独立测试。
- worker invoke 始终保持简单抽象。
- planner 只通过 `studio_plan` capability 把 task items 放入 queue。
- task queue 只推进 worker tasks,不承载 user request / planning lifecycle。
- scheduler 不进入前期 runtime 重做,只在 Iteration 8 作为 request entry 接入。

## Iteration 0: Canonical Design And Legacy Freeze

目标:

- 确认新的 canonical 文档。
- 标记旧 Studio orchestration 文档为历史参考或迁移到新文档。
- 明确移除 `plan cursor`、`PetPlanningSnapshot`、`requirementState`、Studio-level `awaiting_input`、旧 scheduler 直连 worker 等概念。

交付:

- `run-controller.md`
- `run-controller-iteration-plan.md`
- `../history/studio/run-controller-pr-adjustments.md`

验证:

- 文档中 Studio 职责收敛为 pets / queue / invoke / planner / wiki 五项。
- 文档中没有把 pet 状态作为 prompt snapshot 预塞给 planner。
- 文档中没有把 cursor 作为运行核心。

## Iteration 1: Runtime Config Scope

目标:

先把 Studio 从全局配置中拆出来,让 `workdir` 成为 runtime 创建时传入的配置 scope。

改动:

- 新增 `StudioRuntimeKey { workdir, studioId }`。
- 新增 runtime factory/装配入口:local-agent 使用 `buildStudioForTurn({ workdir, ... })`,上层通过 `StudioRunService` 传入 runtimeConfig。
- Studio config、pet runtime config、wiki root、run store、queue store 都从 runtime key 派生。
- 删除或隔离读取全局 workdir 的 Studio 路径。

不做:

- 不接 planner。
- 不接 worker。
- 不接 scheduler。

验证:

- 单测:两个 workdir 创建的 Studio runtime 不共享 pets / queue / wiki root。
- 单测:普通 pet runtime 能跟随 workdir 解析配置。

## Iteration 2: PetRegistry And Live Status View

目标:

建立 Studio 管理 pets 的唯一内部入口。

改动:

- 新增内部 `PetRegistry`。
- 支持 `listPets()`、`getRuntime(petId)`、`getStatus(petId)`、`isDispatchable(petId)`。
- pet 状态只在 registry 中维护或聚合。

不做:

- 不把 registry dump 成公共 planning snapshot。
- 不把 capability availability 做成新的 Studio 公共模型。

验证:

- 单测:`listPets()` 返回 planner 需要的最小字段。
- 单测:worker invoke 前读取的是当前状态,不是 planner 当时看到的旧状态。

## Iteration 3: Planner Capability

目标:

让 `submitRequest()` 能调用 planner,并通过 `studio_plan` 往 task queue 追加 task items。

改动:

- `studio_plan` capability 暴露 `list_pets` / `enqueue_tasks`。
- `list_pets` 内部读取 `PetRegistry.listPets()`。
- `enqueue_tasks` 接收有序 task list 和可选 `deps`,由 Studio 分配 `taskIndex`、归一化依赖并追加到 queue。
- planner invoke 获得 user request 和 conversation wiki。

不做:

- planner 不维护 queue。
- planner 不生成 runtime state。
- planner 不决定 worker invoke 细节。
- planner 不提交 first-class plan 对象。

验证:

- 单测:planner 可调用 `list_pets` 获取实时 pet 视图。
- 单测:planner 调 `enqueue_tasks` 后 task items 进入 queue。
- 单测:`deps: ['previous']` 会被归一化为前一个 task 的 `taskIndex`。
- 单测:planner 未入队任何 task 时 run 进入 failed 终态。

## Iteration 4: FIFO Task Queue

目标:

建立只包含 worker tasks 的 FIFO task queue。

改动:

- 新增 `submitRequest()` API,立即返回 accepted/runId。
- `submitRequest()` 创建 run 并启动 planning lifecycle。
- planner 调用不进入 task queue。
- planner-enqueued tasks 按顺序成为 queue items。
- queue item 带 `deps`,runner 只 dispatch deps 都 done 的 task。
- runner 按 FIFO admission 工作:每轮只看最早 queued task;前序 task 只要已塞给 pet(status 不再是 queued),当前 task 默认 deps 为空且目标 pet 空闲时就直接塞出。
- dispatch 后不等待 worker 完成;completion callback 更新 task/wiki 并触发下一轮 runner 检查。
- V1 单调度循环,不保存 cursor。

不做:

- 不做复杂优先级、抢占或跨 run fair scheduling。
- 不做 scheduler persistence。
- 不保留旧同步 `invoke()` 主路径。

验证:

- 单测:多次 `submitRequest()` 都能 accepted,并进入各自 run 的 planning lifecycle。
- 单测:planner 入队后的 worker tasks 按 FIFO admission 被塞给 pet。
- 单测:无 deps 且目标 pet 空闲的 task,在前序 task 都已塞出后会立即被塞给 pet,不等待前序 task done。
- 单测:如果前序 task 仍是 queued,后序 task 不会越过它被塞给 pet。
- 单测:有未完成 deps 的 task 不会被 invoke。
- 单测:taskIndex 只作为 trace identity,不是 cursor。

## Iteration 5: Worker Task Runner

目标:

把 task item 转成一次简单 worker invoke。

改动:

- 新增 worker task runner。
- worker invoke 前检查 `PetRegistry.isDispatchable(petId)`。
- dispatch 时 task 进入 running;completion 时 task 进入 done/failed。
- task item 记录 `petRunId`,指向 pet runtime 自己的 run/thread/state。
- worker failure 先用简单策略收敛为 run failed 或 task retry。

不做:

- 不改变 worker runtime 内部调用机制。
- 不让 planner 参与 retry 或改派。
- 不做不可派发时的复杂迁移策略。

验证:

- 单测:目标 pet 不可派发时不 invoke worker。
- 单测:worker 成功后 task 进入 done,并记录 petRunId。
- 单测:worker 失败后 task 进入 failed,且 planner 不重新运行。

## Iteration 6: Wiki Manager

目标:

worker 产出进入 conversation wiki,后续 task 可通过 wiki 读取上下文。

改动:

- 根据 runtime scope + conversation 派生 wiki root。
- worker reply 保存为 source。
- curator 更新 index/topics。
- run done 时标定 `finalTaskIndex` / `finalPetRunId`。

不做:

- 不在 Studio 末端再生成最终答复。
- 不把上游 reply 全量塞进下游 brief。

验证:

- 单测:task done 后写入 source。
- 单测:curator 被调用并发出 `wiki_changed`。
- 单测:最终 reply 来自 `finalPetRunId` 指向的 pet run。

## Iteration 7: Events, Cancellation, Blocked State

目标:

补齐上层 UI 和控制面需要的 run-level 操作。

改动:

- 新增 `subscribe()` run event stream。
- 新增 `getRun()`。
- 新增 `cancelRun()`。
- pet 不可派发时 run 可进入 `blocked`。

不做:

- 不把 pet tool events 纳入 Studio 状态机。
- 不把 pet HITL 暴露成 Studio awaiting_input。

验证:

- 单测:`run_changed` / `wiki_changed` 事件顺序稳定。
- 单测:cancelled run 不再 invoke 后续 task。
- 单测:blocked run 保留 queue/run 状态,等待后续策略处理。

## Iteration 8: Persistence And Scheduler Entry

目标:

在 runtime 模型稳定后再考虑持久化和 scheduler。

改动:

- 设计独立 Studio run/queue store。
- scheduler 到期后只调用 `submitRequest()`。
- crash/restart 后恢复 pending task / blocked run / running task 前的安全状态。

不做:

- 不复用旧 due-run store 作为 Studio queue。
- scheduler 不直接调用 planner。
- scheduler 不直接调用 worker。
- scheduler 不维护 task cursor。

验证:

- 单测:重启后 pending request 可恢复。
- 单测:scheduler job 只调用 `submitRequest()`。
- 单测:idempotency key 不重复创建 run。

当前实现边界:

- 已完成 scheduler entry 的最小边界:due-run scheduler claim 到期请求后只提交 Studio run,不直接调用 planner 或 worker。
- 已完成 due-run store 的 workdir scope、idempotency、trace、metrics 和 `finalPetRunId` completion identity。
- 已新增独立 `StudioRunQueueStore` / `FileStudioRunQueueStore`,用于保存 Studio run snapshot 与 worker task queue items,并提供开放 run 的保守恢复策略。
- 已把 `StudioRunQueueStore` 接入 `createStudioOrchestrator` 的自动保存与启动恢复流程。
- local Studio runtime 使用 workdir-scoped `FileStudioRunQueueStore`。
- 当前恢复策略是保守恢复:planning run 可重新规划,queued/blocked task 可继续推进,已经 handoff 的 running task 不盲目重放,而是恢复为 blocked run 中需要 reconcile 的 failed task。
- 后续可单独做更精细的 running pet run reconcile / resume 策略。

## PR Slicing

建议拆分:

1. Docs only:canonical design + iteration plan + legacy doc pointers。
2. Workdir-scoped Studio runtime shell。
3. PetRegistry + status view。
4. `studio_plan.list_pets` / `enqueue_tasks` planner capability。
5. FIFO task queue + non-blocking `submitRequest()`。
6. Worker task runner + task state。
7. Wiki manager / curator integration。
8. Events, cancellation, blocked state。
9. Persistence + scheduler `submitRequest()` entry。
