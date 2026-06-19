# Studio Run Controller Redesign

本文是 Studio 重做后的 canonical 设计。旧的 Studio orchestration 设计只作为历史参考,不再要求兼容。

Server 启动模式和长期 `StudioRuntimeHost` 生命周期见 `docs/STUDIO_SERVER_MODE_RUNTIME_DESIGN.md`。

核心约定:

- Studio 管理 pets、task queue、worker invoke、planner 入口和 wiki 产出。
- planner 是一个普通 pet,通过 `studio_plan` capability 理解用户意图并把 task items 放入 queue。
- worker 调用保持抽象和简单:Studio 只发起一次任务调用,不关心 worker 内部如何完成。
- task queue 是 worker task 的推进来源,不承载 user request / planning lifecycle。
- pet 状态由 `studio_plan.list_pets` 内部工具读取,不衍生公共 snapshot 概念。

## Goal

Studio 不是 worker,不是 planner,也不是 capability orchestrator。Studio 是 **run controller**:

```text
StudioRuntime(workdir) = PetRegistry + TaskQueue + Runner + WikiManager
```

它接收用户请求,找到 planner,让 planner 往 task queue 追加 task items,再根据 FIFO 与 pet 状态发起 worker invoke。worker 产出完成后,Studio 把结果整理进 conversation wiki,并标定最终可交付的 task / pet run。

这次重做不保留旧 Studio 内部模型。旧的 execute graph、plan cursor、planning snapshot、scheduler due-run 直连 worker 等概念都不进入新设计。

## Runtime Scope

`workdir` 是 Studio runtime 的配置解析边界,不是 Studio 自己的一项业务职责。Studio 被创建出来时已经处在某个 `workdir` scope 内。

- 一个 `workdir` 对应一组 Studio config、pet runtime config、queue/run state 和 wiki 根目录。
- 不同 `workdir` 创建出的 Studio runtime 不共享 queue/run/wiki 状态。
- 普通 pet runtime 也按当前 `workdir` 动态创建或解析配置。
- `workdir` 在服务启动或创建 runtime 时传入,不是全局常量。

建议形态:

```ts
type StudioRuntimeKey = {
  workdir: string;
  studioId: string;
};

type CreateStudioRuntimeInput = {
  workdir: string;
  studioId: string;
  config: StudioConfig;
};
```

local-agent 或 server 层负责根据请求选择 `workdir`,再取得对应 `StudioRuntime`。Studio 内部只使用创建时传入的 scope,不读全局 workdir。

## Responsibilities

### 1. Manage Pets

Studio 维护当前 runtime scope 下已注册 pets 的运行视图:

```ts
type StudioPetDescriptor = {
  petId: string;
  role?: string | null;
  serviceSummary?: string | null;
  status: PetAgentStatus;
};
```

Studio 只管理 pet 视图和 runtime 引用:

- 有哪些 pets。
- 每个 pet 的职责描述和当前状态。
- 哪个 pet 是 planner。
- 根据 `petId` 找到对应 worker runtime。

Studio 不管理 pet 内部 message history、capability routing、tool use 或 HITL。那些都属于 pet runtime。

### 2. Maintain Task Queue

task queue 只放 worker tasks,不放 user request。

第一版保持最小语义:

- `submitRequest()` 立即返回 `{ runId, status: 'accepted' }`。
- user request 进入 run 的 planning lifecycle,直接调用 planner pet,不伪装成 queue item。
- planner 通过 `enqueue_tasks` 往 task queue 追加 worker tasks。
- 后台 runner 按 FIFO admission 消费 task queue。
- 同一 run 中 planner 入队的 task items 按入队顺序 admission。
- FIFO 只要求前序 task 已经被塞给 pet(status 不再是 `queued`),不要求前序 task 已完成。
- 默认 `deps = []` 时,只要前序 queue items 都已塞出、目标 pet 空闲,当前 task 就直接塞给 pet。
- runner 把 task 塞给 pet 后不等待完成;完成回调只更新 task/wiki,并触发后续调度检查。
- V1 只要求单调度循环;可同时存在多个已塞给 pet 的 running tasks,受 pet 空闲状态和 deps 约束。
- 多请求可以同时处于 accepted/planning/running 状态,但不要求多个 run 交错执行。
- 跨 run fair scheduling 后续再做。

task queue 是"下一个可尝试塞给 pet 的 worker task 是什么"的唯一来源。没有独立 plan cursor。如果要知道下一步 worker task,看最早仍为 `queued` 的 task;如果要知道 run 的整体进展,看 run status 和 task items。

### 3. Invoke Workers By FIFO And Pet Status

runner 使用简单 FIFO admission 规则。每一轮只循环处理最早仍为 `queued` 的 task:

- 找到最早仍为 `queued` 的 task。
- 因为每轮只取最早 `queued` task,所以不需要额外的 cursor 或前序扫描;拿到当前 task 就天然表示它前面没有还未塞出的 task。
- 如果它的 `deps` 未全部 `done`,停止本轮调度。
- 如果目标 pet 不空闲,停止本轮调度。
- 如果 ready,将 task 标记为 `running`,发起 worker invoke,记录 `petRunId`,然后继续检查下一个最早 `queued` task。

塞给 pet 之后,调度层不等待该 worker 完成,也不跟踪 worker 内部执行细节。worker 完成由 pet runtime 的完成回调或 promise settlement 更新 task 状态并写 wiki;这个更新再触发一轮 runner 检查。

因此默认 `deps = []` 的 task 规则很直接:只要它成为最早的 `queued` task,且目标 pet 当前空闲,就立即塞给 pet。前序 task 是否已经完成不影响它,前序 task 只需要已经被塞出 queue。

worker 调用在 Studio 视角保持简单:

```ts
type WorkerInvokeInput = {
  petId: string;
  brief: string;
  signal?: AbortSignal;
};
```

这是边界抽象,不是最终代码签名要求。实现可以适配现有 `PetAgentRuntime.invoke(...)`,但 Studio 设计只约束一件事:一个 task item 对应一次简单 worker invoke。`workdir` 从 runtime scope 取得,wiki root 从 conversation context 派生,不在每个调用对象里反复传递。

如果目标 pet 当前不可派发,V1 不让 planner 重新规划。runner 可以让 run 进入 `blocked` 或等待 pet 状态变化;策略化超时和迁移放到后续迭代。

### 4. Handle User Requests Via Planner

Studio 不自己理解 user request。它只负责把 request 交给 planner。这个过程不进入 task queue:

```text
submitRequest(userRequest)
  -> create run(status = planning)
  -> find plannerPetId
  -> invoke planner pet with user request
  -> inject studio_plan capability
  -> planner calls list_pets when it needs pet duties/status
  -> planner calls enqueue_tasks
  -> Studio appends task items to queue
  -> run(status = running)
```

`studio_plan` 是 planner 访问 Studio 视图的唯一入口:

```ts
type StudioPetDescriptor = {
  petId: string;
  role?: string | null;
  serviceSummary?: string | null;
  status: PetAgentStatus;
};

type StudioPlannerTools = {
  list_pets: () => StudioPetDescriptor[];
  enqueue_tasks: (input: {
    tasks: Array<{
      petId: string;
      brief: string;
      acceptanceCriteria?: string[];
      deps?: Array<'previous' | { taskIndex: number }>;
    }>;
  }) => void;
};
```

要点:

- `list_pets` 是 capability 内部工具调用,不是公共 `PetPlanningSnapshot`。
- planner 只负责追加有序 task items 到 queue。
- task queue 由 Studio runtime 持有;planner 只是通过工具请求入队,不直接维护 queue state。
- `deps` 只表达同一 run 内的 task 依赖;`'previous'` 表示依赖当前 task 前一个 queue item。
- Studio 入队时把 `deps` 归一化成具体 `taskIndex` 依赖,不把 `'previous'` 原样持久化;未传时归一化为 `[]`。
- planner 不决定 worker 如何 invoke。
- planner 不负责调度已经入队的 tasks。

### 5. Manage Outputs To Wiki

worker 返回后,Studio 调用 wiki manager / curator:

- 保存原始 worker reply 为 source。
- 更新 conversation wiki 的 index/topics。
- 后续 worker 通过 wiki 自主读取上下文。
- run 完成时标定 `finalTaskIndex` / `finalPetRunId`。

最终用户答复来自最后一个有效 worker task 对应的 pet run。Studio 不在末端再生成回答。

## Core Model

### Run

```ts
type StudioRunStatus =
  | 'planning'
  | 'running'
  | 'blocked'
  | 'done'
  | 'failed'
  | 'cancelled';

type StudioRun = {
  runId: string;
  conversationId: string;
  userRequest: string;
  status: StudioRunStatus;
  finalTaskIndex?: number;
  finalPetRunId?: string;
  createdAt: string;
  updatedAt: string;
};

type StudioRunSnapshot = StudioRun & {
  tasks: StudioTaskQueueItem[];   // 从 task queue 派生的读模型,不是第二份权威状态
};
```

### Run / Queue Store

Studio 内部 run/queue persistence 与 scheduler due-run persistence 是两件事。

```ts
type StudioRunQueueStore = {
  save(snapshot: StudioRunSnapshot): StudioRunSnapshot;
  get(runId: string): StudioRunSnapshot | null;
  list(): StudioRunSnapshot[];
  recoverOpenRuns(): StudioRunSnapshot[];
};
```

边界:

- store 保存 Studio run snapshot 和 worker task queue items。
- due-run store 只保存外部 scheduled request 的 claim/attempt/completion/trace。
- 恢复开放 run 时,`queued` task 保持 queued,`blocked` run 保持 blocked。
- 已经处于 `running` 的 task 不能在重启后盲目重放;第一版恢复策略把 run 置为 `blocked`,把 running task 标记为需要 reconcile 的 failed task,避免重复触发 worker。
- orchestrator 创建时会调用 store 恢复开放 run。恢复循环只重新推进 planning / queued / blocked 状态,不重复执行已 handoff 的 pet run。

### Task Queue Item

Task queue item 是 worker task 的权威形态。user request 不进入这个 queue。需要展示"计划"时,从该 run 已入队的 task items 派生审计视图。

```ts
type StudioTaskQueueItem = {
  runId: string;
  conversationId: string;
  taskIndex: number;              // Studio 按该 run 的入队顺序分配
  petId: string;
  brief: string;
  acceptanceCriteria?: string[];
  deps: number[];                 // 依赖的同 run taskIndex 列表
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  petRunId?: string;              // 指向 pet runtime 自己的 run/thread/state
  errorMessage?: string;
  enqueuedAt: string;
  startedAt?: string;
  finishedAt?: string;
};
```

`taskIndex` 可以作为 trace identity,但它不是 cursor,也不是 planner 生成的 id。

planning lifecycle:

1. run 进入 `planning`。
2. Studio 调 planner。
3. planner 通过 `enqueue_tasks` 追加 task items。
4. Studio 为 task items 分配 `taskIndex`,把 `deps` 归一化为同 run 的 taskIndex 列表,并写入 queue。
5. 如果至少有一个 task 入队,run 进入 `running`;否则 run 进入 `failed`。

task dispatch:

1. 检查 run 是否仍可执行。
2. 检查 FIFO 前序 task 是否都已塞出(status 不再是 `queued`)。
3. 检查所有 `deps` 指向的 task 是否已 `done`。
4. 检查目标 pet 当前是否空闲且可派发。
5. 将 task 标记为 `running`,发起 worker invoke,记录 `petRunId`。
6. 不等待 worker 完成,继续尝试 dispatch 下一个 queued task。

task completion:

1. pet run 完成后,将 task 标记为 `done` 或 `failed`。
2. 写 wiki。
3. 如果该 run 的 tasks 都完成,run 进入 `done` 并标定 `finalTaskIndex` / `finalPetRunId`。
4. 触发下一轮 runner 检查,让依赖它的 task 有机会被塞给 pet。

依赖约束:

- deps 只允许引用同一 run 中已经分配的 taskIndex,不能跨 run。
- `deps: ['previous']` 是 planner tool input 的便利写法,表示依赖当前 task 前一个 queue item;如果当前 run 中不存在前一个 queue item,该输入非法。
- V1 runner 是 FIFO admission,不是同步串行执行;deps 只作为 readiness guard。
- 依赖 task failed/cancelled 时,依赖它的 task 不会被 invoke;第一版可将 run 收敛为 `failed` 或 `blocked`。

Studio 不维护独立 `Dispatch` 模型。pet 的 messages/state/run 是 worker 执行事实的权威来源;Studio task item 只保留最小外壳状态和指向 pet run 的引用。

## Event Boundary

Studio 对外只发少数编排级事件。状态细节放在 payload,不把每个状态拆成独立 event name。

```ts
type StudioRunEvent =
  | {
      type: 'run_changed';
      runId: string;
      conversationId: string;
      status: StudioRunStatus;
      snapshot: StudioRunSnapshot;
      reason?: string;
      occurredAt: string;
    }
  | {
      type: 'wiki_changed';
      runId: string;
      conversationId: string;
      changedPaths: string[];
      occurredAt: string;
    };
```

收敛规则:

- `planning / running / blocked / done / failed / cancelled` 是 `run_changed.status`,不是独立事件。
- 对外 canonical event 不再发 `planning_started` / `task_queued` / `dispatch_started` / `dispatch_finished` 这类细粒度事件。
- task 入队、开始、完成、失败都体现为 `run_changed.snapshot` 的变化。
- wiki 文件发生变化时发 `wiki_changed`,用于 UI 或上层缓存刷新。

本地 TUI/server bridge 可以保留 `StudioTurnEvent` 作为低层进度流,例如 `tasks_queued`、`task_started`、`task_finished`、`wiki_updated`。这些事件只用于本地渲染和 trace,不作为 canonical Studio 事件边界。

pet 内部 tool events、HITL、capability progress 仍走 pet runtime 自己的事件边界。Studio 可以透传给 UI,但不把这些事件纳入 Studio 状态机。

## Public API

新 Studio 不以同步 `invoke()` 为核心 API。

```ts
type StudioRuntime = {
  submitRequest(input: {
    conversationId: string;
    userRequest: string;
    signal?: AbortSignal;
  }): Promise<{ runId: string; status: 'accepted' }>;

  getRun(runId: string): StudioRunSnapshot | null;
  subscribe(handler: (event: StudioRunEvent) => void): () => void;
  cancelRun(runId: string): Promise<void>;
};
```

如果上层需要同步等待,由上层自己组合 `submitRequest()` + `getRun()` / `subscribe()`。Studio runtime 不为了兼容旧调用方式保留同步主路径。

## Scheduler Boundary

scheduler 只作为 Studio request entry,不参与 Studio 内部 task queue。

约束:

1. scheduler 只提交 Studio request。
2. Studio 仍负责 planner lifecycle、task queue、worker invoke 和 wiki。
3. scheduler 不直接调用 planner 或 worker。
4. scheduler 不维护 plan task cursor。
5. due-run store 只记录外部到期请求、claim、attempt、completion 和 trace,不复用为 Studio task queue store。
6. crash/restart 恢复 Studio 内部 pending/blocked/running-before-handoff 状态由独立 Studio run/queue store 负责。
7. 已经 handoff 给 pet 的 running task 不由 scheduler 重放;后续如需更精细恢复,应做 pet run reconcile / resume。

## Removed Legacy Concepts

以下概念不进入新 Studio:

- `plan cursor`:queue head 即下一步。
- `PetPlanningSnapshot`:planner 通过 `studio_plan.list_pets` 读取实时 pet 视图。
- first-class `StudioTaskPlan`:task 的权威状态在 queue 中,计划视图从入队记录派生。
- `request` queue item:user request 走 planning lifecycle,不进入 worker task queue。
- `StudioDispatch`:Studio 不镜像 pet 内部执行事实,task item 只保留最小状态和 `petRunId`。
- `requirementState`:缺信息由 planner pet 自己通过 HITL 处理。
- Studio-level `awaiting_input`:HITL 属于 pet runtime,Studio 只看到 task running/done/failed。
- `ExecuteAction` 作为公共设计对象:runner 可以有内部分支,但不把它作为架构概念。
- `envelope` 型 worker 协议:worker invoke 是简单任务调用。
- 旧 due-run scheduler 直接驱动 planner/worker。
- 旧 `invoke()` 同步 turn 兼容入口。

## Non-Goals

- 不设计 worker 内部如何调用模型、tool、capability。
- 不在 Studio 层做 capability routing。
- 不在 Studio 末端生成最终答复。
- 不做复杂优先级、抢占或跨 run fair scheduling。
- 不做跨 workdir queue。
- 不把 scheduler 放进本轮重做。
