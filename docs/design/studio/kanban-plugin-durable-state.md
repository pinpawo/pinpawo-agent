# Studio Kanban Plugin Adapter

> 状态：Draft integration contract
> 对应：#638 后续阶段
> 更新：2026-08-23
> Kanban 数据设计：[Kanban SQLite Task Store](../kanban/sqlite-task-store.md)
> Console UI：[Kanban Console UI](../kanban/ui-console.md)

Kanban 是独立领域。Studio Kanban Plugin 只是把一个 `KanbanTaskService` 接到 Studio
的 dispatch、event、Toolkit definition 和 Plugin hook；它不定义 task storage，也不让
Studio 拥有 Kanban 数据。

## 1. 适配边界

```text
KanbanTaskService
  ├─ Studio Toolkit adapter ──> ordinary Agent tool calls
  ├─ Studio runner adapter  ──> context.dispatch()
  ├─ Studio event adapter   ──> context.notify()
  └─ HTTP routes adapter    ──> context.hooks.contribute('http', 'routes', ...)

Studio core -X-> Kanban repository / SQLite
Pet runtime  -X-> Kanban repository / SQLite
```

- Plugin factory 接收或创建 Kanban application service；database path 和 repository
  options 由 Kanban/application composition 校验。
- `StudioPluginContext` 不增加 Kanban 字段，也不提供数据库。
- Plugin 可定义 Kanban Toolkit；Host 将 definition 放入统一 inventory，Capability 决定哪个
  Pet 使用它。Plugin lifecycle 不参与 Capability 选择或 Pet runtime 装配，见
  [Studio Independent Host Runtime](independent-host-runtime.md)。
- Agent 只看到普通 tool input/output，不看到 SQLite、history sequence、HTTP route、
  invocation identity 或 UI 授权状态。
- task 与 receipt 的临时关联只存在于 Plugin dispatch closure，不写入 Studio metadata。

## 2. Toolkit adapter

当前 Studio-facing Toolkit 可以继续使用 Pet 语义：

```text
kanban_task_add({ petId, brief, dependsOn })
kanban_task_list()
kanban_task_complete({ taskId, result })
kanban_task_block({ taskId, reason })
```

adapter 把 `petId` 映射成独立 Kanban model 的 `assigneeId`，然后调用
`KanbanTaskService` command。Tool 不直接访问 repository，更不能执行 SQL。

## 3. Dispatch adapter

Kanban domain 把 ready/claim 表达成 committed mutation；Studio Plugin 决定如何用 Pet
执行它：

```text
service.claimNextReadyTask()
        |
        | committed doing + claimed event
        v
context.notify(task.doing)
context.dispatch({
  petId: task.assigneeId,
  request: buildTaskRequest(task)
})
        |
        v
receipt.completion
  ├─ waiting           -> no Kanban task mutation
  ├─ failed/cancelled  -> service.blockTask(...)
  ├─ Toolkit completed -> service.completeTask(...)
  └─ completed without outcome -> service.blockTask(...)
```

Studio dispatch 的 `waiting` 只说明 resident Pet 当前不能完成这次单向派发，不是 Kanban
task transition。Kanban adapter 不得据此调用一个只接受 reason 的 `waitTask()`，也不定义
`markWaiting()`；Studio receipt/event 也不向 Kanban 投射 `continuationId` 或 opaque
payload。task 保持 Agent 最后一次通过 Kanban Toolkit 明确提交的领域状态。

pending interrupt 由同一 Pet 的 local-agent Agent Session conversation 展示与恢复，不通过
Kanban、HTTP Plugin 或 dispatch。conversation 恢复后，Agent 可以继续通过 Kanban Toolkit
完成或阻塞 task；Kanban 仍不读取 checkpoint。Kanban 若保留 `waiting` 领域状态，必须在
独立设计中由 Kanban-owned typed attention/authorization record 支撑，不能从 Studio gate、
dispatch result 或任意 reason 推导。

当前实现中的 `waitTask()`、`waitForContinuation()`、`continuation_json` 以及
`finishUnreportedTask()` 对 public continuation 的处理都是旧 dispatch-resume 模型的
transitional surface。Pet-scoped Agent Session route 和 waiting/resume E2E 落地后，应在
实现 PR 中一并移除或迁移；本目标 adapter 不调用它们。

claim transaction 失败时不得 dispatch。Plugin 只消费自己发出的 receipt，不订阅 Agent
graph state，不读取 `threadId`，也不把 `taskId` 塞进 execution metadata。taskId 只作为
自然语言 request 和普通 Toolkit command 的领域参数。

## 4. Event adapter

每个 committed `KanbanDomainEvent` 由 Plugin 投射为 live Studio event：

```ts
context.notify({
  type: `task.${task.status}`,
  payload: {
    sequence: event.sequence,
    taskId: task.taskId,
    petId: task.assigneeId,
    note: task.note,
  },
});
```

Studio event 是实时通知，不是 Kanban 数据库。丢失 live event 后，Kanban Web/HTTP adapter
可用 service snapshot/history 恢复；Studio 不负责 replay Kanban history。

## 5. HTTP hook adapter

Kanban 可继续向可选 HTTP Plugin 贡献 route，但 handler 只调用 Kanban service：

- `GET /kanban`：current task snapshot + `lastEventSequence`；
- `GET /kanban/events?after=<sequence>&limit=<n>`：Kanban history。

HTTP Plugin 负责 server、Bearer auth、Origin/CORS 和 response；Kanban 负责 read model。
HTTP 不 import Kanban，Kanban 在没有 HTTP Plugin 时仍可通过 CLI、内嵌 Web 或其他 adapter
独立运行。

## 6. 生命周期

若 Plugin factory 自己创建 service，它在 `start()` 中初始化 repository 和 recovery，在
`stop()` 中停止 claim、等待 tracked receipt projection、移除 hook 后关闭 service。

若 composition 注入共享 application service，service lifecycle 由 composition root 持有，
Plugin 只注册和释放 Studio adapters。两种模式必须显式区分，避免 Plugin stop 意外关闭
仍被独立 Kanban Web/CLI 使用的 service。

## 7. 验收标准

- Studio、pet-agent、local-agent 不 import Kanban repository 或 SQLite 类型。
- Kanban domain/service/repository 不 import Studio 类型。
- 所有 Studio 派活只走 `context.dispatch()`，所有 live 通知只走 `context.notify()`。
- Agent 侧只有普通 Toolkit，不新增 Kanban graph state、checkpoint 或 execution metadata。
- Studio `waiting` result 不直接改变 Kanban task status，也不把 continuation 存入 Kanban。
- HTTP hook handler、Toolkit 和 dispatch adapter 共用同一个 Kanban service。
- 没有 Studio 时，同一个 Kanban service 仍可被 Kanban CLI/Web 使用。

## 8. 非目标

- 把 Kanban 数据提升为 Studio state；
- 让 Studio event 代替 Kanban task history；
- 让 HTTP Plugin 或 Studio core 直接读写 Kanban SQLite；
- Agent Session interaction、知识图谱或 UI 视觉设计。
