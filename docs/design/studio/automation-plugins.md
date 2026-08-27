# Studio Automation Plugins

> 状态：Draft implementation contract
> 更新：2026-08-28

Scheduler 与 Trigger 是两个可选 Studio Plugin。它们把“何时产生输入”和“外部输入如何
进入”建模为独立领域，然后只通过 `StudioPluginContext.dispatch()` 向 Pet 提交单向输入，
通过 `notify()` 发布领域事件。

领域 Service 是 committed-mutation 的唯一出口。Plugin 订阅这个出口并统一投射 Studio
event；HTTP route、应用代码或其他 adapter 调用 Service 时不各自补发事件。

```text
Scheduler SQLite -> due claim -> context.dispatch()
Trigger HTTP input -> delivery claim -> context.dispatch()

Scheduler/Trigger -X-> Agent / thread / checkpoint / Agent Session
Scheduler/Trigger -X-> Kanban database or service
Studio core       -X-> Scheduler/Trigger concrete package
```

两个 Plugin 都可向 HTTP Plugin 的 `routes` hook 贡献 API，但不依赖 HTTP 才能启动。
HTTP 只承载 request/response；领域校验、幂等、持久化和 recovery 由贡献 route 的 Plugin
负责。

## Scheduler 第一版

第一版支持 durable one-shot schedule：`scheduleId/petId/request/runAt/status`。启动时把所有
已到期且仍为 `scheduled` 的记录视为 missed fire，并按原计划只 claim/dispatch 一次。
SQLite transaction 先把记录原子地转成 `dispatching`，再调用 `context.dispatch()`；接受后
标记 `dispatched`，表示 resident queue 已接纳而不是 Agent 执行完成；admission 失败标记
`failed`。崩溃遗留的 `dispatching` 标记为
`failed`，避免无法证明安全时重复派发。

管理 API：

- `GET /scheduler`：snapshot；
- `POST /scheduler`：创建 `{ petId, request, runAt }`；
- `POST /scheduler/control`：`cancel` 尚未 claim 的 schedule；
- `GET /scheduler/events`：durable history cursor。

周期/cron、时区规则、重试和复杂 missed-fire policy 留到后续；第一版不自己实现 cron
parser。

## Trigger 第一版

Trigger 定义由 Plugin options 提供：`triggerId/petId/requestPrefix/secret`。SQLite 只保存
delivery，不保存明文 secret。外部调用固定 `POST /triggers/invoke`，携带
`Authorization: Trigger <secret>` 和 `{ triggerId, idempotencyKey, payload }`。

Trigger 先验证定义、secret、body 和 idempotency key，再以
`(triggerId, idempotencyKey)` 原子创建 delivery。首次接收调用 `context.dispatch()`；重复
调用返回已有 delivery，不再次派发。admission 失败持久化为 `failed`，不自动重试。

管理 API `GET /triggers` 与 `GET /triggers/events` 使用 Studio Bearer；外部 invoke route
声明 route-owned authentication，由 Trigger 自己验证 secret。HTTP Plugin 只提供这一
通用鉴权策略，不读取 Trigger 配置。

## Pet 与事件

Plugin 在 `start()` 时通过 `listPets()` 验证目标 Pet。运行中所有 dispatch 都使用标准
`context.dispatch()`，所有事件只包含领域 identity/status，不向 Agent execution metadata
注入 scheduler/trigger/kanban 字段。
