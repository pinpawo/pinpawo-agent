# Kanban SQLite Task Store

> 状态：Draft implementation contract
> 更新：2026-09-02

本文定义独立 Kanban 领域的 task、dependency、history 与 SQLite persistence。
Kanban 可以被 CLI、Web、Studio adapter 或其他 application composition 使用；它的数据
模型、状态机、repository 和恢复策略不属于 Studio。

## 实现状态

当前仓库已实现第一、二阶段的最小闭环：

- `plugins/kanban/src/kanbanTaskService.ts` 提供独立的 SQLite repository、service、
  transaction、history cursor 和 `doing -> blocked` recovery；
- `migrateKanbanSnapshotToSqlite()` 提供从旧 JSON snapshot 到空 SQLite target 的显式、
  一次性迁移；原文件会保留；
- Studio Kanban Plugin 只通过 service 构建 Toolkit、Studio event projection 和可选 HTTP
  adapter；它不读取 Pet registry，也不发起 Studio dispatch。
- 运行时 JSON snapshot store 已移除，SQLite 是持久化路径。

旧 dispatch-resume adapter 的 `waitTask(reason)`、public continuation 与
`continuation_json` 已移除；schema v4 会显式删除 v2 的 continuation column，并将旧
`brief` 拆分为供列表识别的 `title` 与承载完整执行输入的 `detail`。Studio
dispatch receipt 只表示 resident 已接纳输入，不产生 Kanban task transition。

仍未实现独立 Kanban CLI/Web composition。Studio Console 已通过 Kanban HTTP command 做用户
assignment；其他 UI 不能通过绕开 service 或直接读写 SQLite 来临时补齐。

## 1. 领域边界

```text
Kanban CLI ───────┐
Kanban Web ───────┼──> KanbanTaskService ──> KanbanTaskRepository ──> SQLite
Studio adapter ───┘             |
                                └──> committed KanbanDomainEvent
```

- SQLite 是 Kanban task、dependency 和 task history 的唯一持久事实源。
- `KanbanTaskService` 是 Kanban 的 application API。状态校验、transaction、assignment 和
  recovery 只能通过该 API / repository 完成。
- Kanban CLI/Web 可以在同一 application process 内直接使用 service，也可以通过一个
  Kanban-owned HTTP adapter 远程调用；它们不需要经过 Studio。
- database schema 和 SQL 不是公共客户端 API。任何 adapter 都不能绕过 service 直接写表。
- Studio Plugin 只是 Kanban 的一个可选 adapter。Studio dispatch/event/hook 不进入本设计
  的数据模型。
- 第一阶段一个 application instance 持有一个 database writer。其他进程通过 application
  API 访问，不共同写同一个 SQLite 文件。

推荐默认路径由 Kanban application composition 选择：

```text
<workdir>/.pinpawo/kanban/<instance>/kanban.sqlite
```

嵌入 Studio 时可以由 composition 选择
`<workdir>/.pinpawo/studio/<plugin-instance>/kanban.sqlite`，但这只是部署路径，不改变
数据库所有权。

## 2. 领域模型

```ts
type KanbanTaskStatus = 'todo' | 'assigned' | 'doing' | 'waiting' | 'done' | 'blocked';

type KanbanTask = {
  taskId: string;
  assigneeId?: string;
  title: string;
  detail: string;
  status: KanbanTaskStatus;
  deps: string[];
  note?: string;
  createdAt: string;
  updatedAt: string;
};

type KanbanTaskEvent = {
  sequence: number;
  taskId: string;
  eventType: 'created' | 'imported' | 'assigned' | 'started' | 'waiting' | 'completed' | 'blocked' | 'recovered';
  fromStatus?: KanbanTaskStatus;
  toStatus: KanbanTaskStatus;
  note?: string;
  occurredAt: string;
};
```

`assigneeId` 是用户显式选择后的执行目标标识，初始为空；Kanban 不解析、不验证或枚举
该标识。它可以代表 Pet、worker、team 或用户。Studio 中，Console 把用户的选择写成该值，
随后 Trigger 规则自行决定是否以及如何把 `task.assigned` 路由到对应 Pet；允许的目标集合也由
该规则配置，而不是由 Kanban 保存。

`title` 是面向列表和快速识别的简短交付名称；`detail` 是交给执行者的完整任务输入，包含
目标、完成标准、必要上下文与应保留的证据。二者描述同一个 task，不形成额外的执行层级。

状态语义：

- `todo`：尚未被用户指派。全部 dependency 都是 `done` 后才可以指派。
- `assigned`：用户已选择执行目标，且已提交 `task.assigned` 事件；外部 dispatch 的接纳或失败
  不会伪造为 task 正在执行。
- `doing`：执行者通过 Kanban command 明确声明已经开始。
- `waiting`：Kanban 已持久化一条由自身领域定义的 typed attention/authorization record；
  它优先进入人可处理的 attention read model。裸 reason、Studio gate 或 dispatch receipt
  不能产生这个状态。
- `done`：执行者已经明确报告完成。
- `blocked`：无法安全自动继续，需要人或上层策略决定；不会自动重试。执行者后续通过
  Toolkit 明确报告有效完成结果时，可以转为 `done`，这不要求 Kanban 理解执行 checkpoint。

第一阶段不加入泳道、卡片坐标、颜色、UI 排序或任意 `metadata_json`。这些不是 task
执行事实。Web 可把 `waiting` 投射到最高优先级授权区，把其他 task 投射成依赖流。

项目知识图谱也不进入 task 表。project-map / knowledge 是独立领域；Kanban 后续如需
关联，只增加明确的 entity reference，不复制图谱，也不塞入任意 metadata。

## 3. SQLite schema

```sql
CREATE TABLE kanban_tasks (
  task_id       TEXT PRIMARY KEY,
  assignee_id   TEXT,
  title         TEXT NOT NULL,
  detail        TEXT NOT NULL,
  status        TEXT NOT NULL
                CHECK (status IN ('todo', 'assigned', 'doing', 'waiting', 'done', 'blocked')),
  note          TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE kanban_task_dependencies (
  task_id             TEXT NOT NULL,
  depends_on_task_id  TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id),
  FOREIGN KEY (task_id) REFERENCES kanban_tasks(task_id) ON DELETE CASCADE,
  FOREIGN KEY (depends_on_task_id) REFERENCES kanban_tasks(task_id) ON DELETE RESTRICT
);

CREATE TABLE kanban_task_events (
  sequence       INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id        TEXT NOT NULL,
  event_type     TEXT NOT NULL,
  from_status    TEXT,
  to_status      TEXT NOT NULL,
  note           TEXT,
  occurred_at    TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES kanban_tasks(task_id) ON DELETE RESTRICT
);

CREATE INDEX kanban_tasks_status_created
  ON kanban_tasks(status, created_at, task_id);

CREATE INDEX kanban_dependencies_dependency
  ON kanban_task_dependencies(depends_on_task_id, task_id);

CREATE INDEX kanban_task_events_task_sequence
  ON kanban_task_events(task_id, sequence);
```

dependency 必须引用已存在 task。这样拼错的 ID 会立即失败，而不是产生永远不能 ready
的 task。调用方可先创建上游，再用返回 ID 创建下游；未来若需要一次性创建整张计划，
增加显式 batch command，在同一个 transaction 中校验整张 DAG。

第一阶段 dependency 在 task 创建后不可修改，因此按创建顺序引用已有 task 时天然不会
形成环。未来若开放 dependency 修改，必须在 commit 前做 cycle detection。

`sequence` 只在一个 Kanban database 内单调递增。第一阶段没有直接编辑 task 的 Web
command，不提前加入 UI revision/version 字段；状态条件 update 足以保护 transition。

## 4. Application service 与 repository

```ts
type KanbanTaskSnapshot = {
  tasks: KanbanTask[];
  lastEventSequence: number;
};

type KanbanMutation = {
  task: KanbanTask;
  event: KanbanTaskEvent;
};

type KanbanTaskRepository = {
  init(): Promise<void>;
  close(): Promise<void>;
  readSnapshot(): Promise<KanbanTaskSnapshot>;
  getTask(taskId: string): Promise<KanbanTask | null>;
  createTask(input: CreateKanbanTaskInput): Promise<KanbanMutation>;
  assignTask(taskId: string, assigneeId: string): Promise<KanbanMutation>;
  startAssignedTask(taskId: string): Promise<KanbanMutation>;
  completeTask(taskId: string, result: string): Promise<KanbanMutation>;
  blockTask(taskId: string, reason: string): Promise<KanbanMutation>;
  recoverInterruptedTasks(): Promise<KanbanMutation[]>;
  listTaskEvents(afterSequence?: number, limit?: number): Promise<KanbanTaskEvent[]>;
};
```

Repository 保证每个 mutation 在一个 transaction 内：

1. 校验当前状态与 command；
2. 修改 task / dependency；
3. 插入一条 task event；
4. commit；
5. 返回 `{ task, event }`。

`KanbanTaskService` 在 commit 后投射 `KanbanDomainEvent` 给当前 application 的 adapters。
数据库失败时不得发布成功事件或启动外部执行。

`assignTask` 使用原子 transaction：只接受 dependency 均完成的 `todo` task，把用户选择的
不透明 `assigneeId` 与 `assigned` 状态一并写入，再追加 assigned event。`startAssignedTask`
只允许该 task 的执行者在实际工作开始时把 `assigned` 改成 `doing`。Kanban 不根据 Pet 可用性
自动 claim、排队或重试；并发、路由和 delivery policy 属于 Trigger / Host。

## 5. Domain event 与历史

`kanban_task_events` 是 Kanban 的领域历史，不是某个 transport 的消息表。它支持：

- 流式 UI 展示 task 的真实推进过程；
- snapshot 与 live connection 之间的 gap recovery；
- crash 后解释 task 为什么从 `doing` 变成 `blocked`；
- 将来为 Kanban 自己增加 audit / diagnosis。

每条 committed mutation 同时获得一个 `sequence`。in-process adapter 收到的
`KanbanDomainEvent` 携带同一 sequence，可以与 history 查询去重。

第一阶段不自动清理 history。若以后需要 compaction，必须先定义 snapshot cursor、最小
保留 sequence 和客户端过期策略，不能直接按时间删除。

## 6. Crash consistency 与恢复

用户 assignment 必须先持久化，再由外部 Trigger 决定是否派发：

```text
BEGIN IMMEDIATE
  todo -> assigned
  append assigned event
COMMIT
        |
        | only after commit
        v
Trigger routes the selected target
```

commit 失败时不得派发。commit 成功但进程在外部执行前崩溃时，数据库保留 `assigned`，由
Trigger delivery history 说明是否需要重试。只有执行者明确开始后的 `doing` 会在下次
application start 中改为 `blocked`，逐条写入 recovered event，避免无法证明旧动作是否发生时自动重试。

已有 `waiting` 在重启后保留；恢复它所需的 typed attention/authorization record 由
Kanban 自己持久化和管理，不从 Agent checkpoint、Studio event 或 application adapter 的
任意 reason 推导。该 typed record 尚未进入当前最小 schema，因此目标 application API
暂不提供创建 `waiting` 的通用 command。

## 7. SQLite lifecycle

仓库要求 Node.js 24+，优先使用内置 `node:sqlite`，避免额外 native addon。连接配置：

```text
PRAGMA foreign_keys = ON
PRAGMA journal_mode = WAL
PRAGMA synchronous = FULL
PRAGMA busy_timeout = 5000
PRAGMA trusted_schema = OFF
```

SQLite migration 使用 `PRAGMA user_version`，只允许向前迁移。migration 失败必须让
Kanban application start 失败，不能删除、重建或静默清空数据库。

从自动派发 schema v4 迁移时，旧 `todo` task 的 assignee 会被清空：旧值代表曾经的
自动路由意图，而不是本模型下用户确认过的 assignment。用户需要在 Console 中重新选择目标，
才能产生新的 `task.assigned` 事件和 Trigger delivery。

写 transaction 必须很短；禁止在 transaction 内等待 runner、event listener、HTTP 或
其他网络操作。数据库目录权限为 `0700`，database/WAL/SHM 文件限制为当前用户可读写。

application lifecycle：

1. 打开 repository 并执行 migration；
2. transactionally recover `doing -> blocked`；
3. 发布 committed recovery events；
4. 对 adapter 开放 service；
5. shutdown 时先停止新 command / assignment，再等待 adapter 停止，最后关闭 repository。

## 8. CLI、Web 与 adapter

Kanban CLI/Web 属于 Kanban application，可以：

- 与 service 同进程运行并直接调用 application API；
- 或通过 Kanban-owned HTTP adapter 调用远端 service；
- 订阅 committed domain event 更新 UI。

独立前端的最小信息结构、read recovery 和 MVP 交互见
[Studio Console](../studio/console.md)。它只消费 service/adapter，不改变 Kanban task
storage 或 domain event 的所有权。

它们不能直接执行 SQL，是为了保持 Kanban 自己的 transaction 和状态机，不是因为必须
通过 Studio。Studio、HTTP Plugin、桌面应用等都只是可选 adapter。

通用 read recovery：

1. 从 service 读取 snapshot 与 cursor `S`；
2. 连接 live domain event adapter；
3. 查询 history `after=S`；
4. 按 `sequence` 合并 backfill 与 live event 并去重。

第一阶段不提供绕过领域 command 的 task CRUD。人或 agent 如需直接管理 task，也必须
调用 `createTask` / `completeTask` / `blockTask` 等明确 command。

Studio Kanban Plugin 只是一个可选 adapter：用户 assignment 必须先由 service commit，再投射
`task.assigned`。Trigger 是消费该事件并决定 Studio dispatch 的可选 adapter；admission 成功或失败
写入 Trigger delivery history，不改变 Kanban task 的事实状态。执行者收到请求后以
`kanban_task_start` 进入 `doing`，并用 `kanban_task_complete` 或 `kanban_task_block` 提交结果。
Kanban Plugin 不读取 Pet registry、checkpoint、thread、Agent Session 或 execution metadata。
HTTP route 与 Toolkit 也必须复用同一个 `KanbanTaskService`。

Studio adapter 提供职责分离的 Toolkit projection：`kanban-planning` 读取 task
快照并创建最终交付，`kanban-execution` 读取已分派 task 并提交开始、完成或阻塞结果。通用
`kanban` Toolkit 继续作为完整领域接口存在，但示例 Planner 与执行 Pet 使用各自的最小
projection，使可调用能力与 Pet 职责一致。

同一执行目标的并发、排队和重试不属于 Kanban 领域策略。它们由 Trigger rule、Host 或未来的
专用 worker scheduler 明确配置；Kanban 只保留用户 assignment 与执行者的领域回报。

## 9. JSON snapshot 迁移

SQLite 落地后，新 application 默认只创建 `kanban.sqlite`，不隐式扫描旧 JSON。
如需保留数据，使用显式迁移：

```ts
migrateKanbanSnapshotToSqlite({ snapshotFile, databaseFile })
```

它严格校验 snapshot，要求目标 database 尚无 task/event，在一个 transaction 中写入 task、
dependency 和 `imported` event。成功后保留原 JSON，由调用者确认后自行归档；旧 `doing`
会立刻走标准 recovery 变为 `blocked`。重复调用明确报告 target is not empty，不得重复创建 task。

迁移期可暂时保留 file store compatibility adapter，但同一 Kanban instance 只能有一个
writable truth source。

## 10. 实施阶段

### PR 1：独立 Kanban domain 与 SQLite repository

- 把 task model、service、repository contract 从 Studio adapter 中分离；
- 实现 schema、migration、transaction、atomic assignment 和恢复；
- 覆盖 dependency、状态转移、assignment、重启恢复和损坏 schema 测试；
- 不修改 Studio 或 Agent runtime。

### PR 2：现有 adapters 迁移

- Kanban Toolkit 改为调用 application service；
- Studio Kanban Plugin 改为消费 domain event，并负责 dispatch/event/hook adapter；
- 现有 HTTP snapshot route 改为 service read model；
- 移除运行时全量 JSON snapshot save。

### PR 3：Kanban flow read model 与快速启动

- 增加 history query adapter；
- 提供可运行的 Kanban Web/CLI composition；
- Studio composition 只是其中一种可选启动方式。

## 11. 验收标准

- Kanban domain/service/repository 不 import Studio、pet-agent 或 local-agent。
- 每个 mutation 与 task event 原子提交；commit 失败不发布成功 event、不执行外部动作。
- 同一 `todo` task 只能被一次有效 assignment 转成 `assigned`。
- Studio 事件投射不枚举或隐式选择 Pet；外部路由必须通过显式 Trigger rule。
- crash 后 `doing -> blocked`、`waiting` 保留，恢复变化进入 history。
- CLI/Web 可独立运行 Kanban，不需要 Studio。
- 所有 adapter 通过 service/command/read model 使用 Kanban，不直接写 SQLite。
- 知识图谱不进入基础 task schema。

## 12. 非目标

- Studio core 的 database/repository abstraction；
- Agent checkpoint 或任意 runner continuation 的持久化；
- project knowledge graph schema / ingest；
- 多进程共同写一个 Kanban database。
