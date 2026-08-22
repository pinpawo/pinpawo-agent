# Kanban Plugin Durable State

> 状态：Draft implementation contract
> 对应：#638 后续清理
> 更新：2026-08-23

本文只定义可选 Kanban Plugin 自己的状态与派发闭环。Studio core 不认识 task、
board、Kanban 文件或恢复策略；Pet runtime 和 local-agent 也不承担这些职责。

## 1. 所有权边界

```text
application composition root
  └─ 为具体 Kanban Plugin instance 选择 state store / file path

Kanban Plugin
  ├─ KanbanBoard domain state
  ├─ durable snapshot load/save
  ├─ task -> dispatch receipt closure
  └─ task status projection

Studio
  └─ opaque dispatch + receipt
```

- `StudioPluginContext` 不增加 Kanban 专属字段，也不提供通用隐式数据库。
- Plugin factory 接受可选的 `KanbanStateStore`；没有 store 时仍可作为纯内存 Plugin 使用。
- 文件 store 是 Kanban package 的实现。应用装配者决定文件路径；推荐位置是
  `<workdir>/.pinpawo/studio/<plugin-instance>/kanban.json`。
- Plugin 不把 `taskId`、route 或其他内部状态塞入 Studio metadata，也不读取
  `threadId`。task 与 invocation 的关联只存在于发起 dispatch 的闭包中。

## 2. Durable snapshot

文件格式带显式版本，读取时严格校验；损坏或不支持的状态必须让 Plugin 启动失败，
不能静默清空看板。保存使用同目录临时文件加原子 rename，Plugin 串行提交 snapshot，
避免较旧的异步写覆盖较新的状态。

Plugin 在向 Studio dispatch 前，必须先把 task 的 `doing` 状态持久化。这样进程在
“已决定派发”和“dispatch 已接受”之间崩溃时，重启会把该 task 恢复为 `blocked`，
而不是静默重复执行外部动作。

恢复规则：

- `todo` / `done` / `blocked` 保持原状；
- `doing` 变为 `blocked`，原因是进程中断后无法证明旧 invocation 是否仍在执行；
- `waiting` 保持 `waiting`，因为 pending interrupt 已由 Pet checkpoint 持久化，
  后续 interaction Plugin 仍可以恢复它。

## 3. Dispatch result projection

Kanban Plugin 消费自己拿到的 `StudioDispatchReceipt.completion`：

- Agent 已通过 Kanban Toolkit 把 task 标成 `done` 或 `blocked`：保持 Agent 决定；
- `pending_interrupt`：task 变为 `waiting`；
- `failed` / `cancelled`：task 变为 `blocked` 并记录原因；
- invocation `completed` 但 task 仍是 `doing`：变为 `blocked`，明确记录 Agent
  没有报告 task outcome，避免永久假运行。

`waiting` task 仍允许 Kanban complete/block 工具收口。interaction Plugin 恢复同一个
Pet checkpoint 后，Agent 可以继续执行原调用并更新该 task；Kanban 不需要知道恢复
dispatch 的 thread 或 invocation identity。

## 4. 非目标

- Plugin discovery / 安装策略；
- interaction Plugin 与 pending-action 索引；
- HTTP 页面、Wiki ingest、trigger 或 scheduler；
- durable Studio event log；
- 把 Kanban 状态或策略提升进 Studio core。
