# Studio Automation Plugins

> 状态：Draft implementation contract
> 更新：2026-08-28

Scheduler 与 Trigger 是两个可选 Studio Plugin。Scheduler 表达时间条件；Trigger
表达“满足某个事件源条件时，向哪个 Pet 派发什么请求”。二者只通过
`StudioPluginContext.dispatch()` 向 Pet 提交单向输入，通过 `notify()` 发布领域事件。

领域 Service 是 committed-mutation 的唯一出口。Plugin 订阅这个出口并统一投射 Studio
event；HTTP route、应用代码或其他 adapter 调用 Service 时不各自补发事件。

```text
Scheduler SQLite -> due claim -> context.dispatch()
event source -> Trigger binding condition -> context.dispatch()

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

一个 Trigger 是一条独立绑定：`source condition -> petId + request`。第一版有两种 source：

- `http`：一个具名外部 HTTP source；
- `github`：经 GitHub `X-Hub-Signature-256` 签名验证的 webhook，并可按 GitHub
  `event` 与 payload `action` 条件匹配；
- `studio_event`：Studio event bus 上匹配 `eventSource` 及精确 `type` 或 `typePrefix`
  的事件。

因此 Kanban 的 `task.*` 事件、未来 GitHub Plugin 发布的 `pull_request.*` 事件，都可以
作为 Trigger 的条件；它们不需要为“什么时候 dispatch”各自实现一个薄插件。外部事件源
由其 owning Plugin 通过 `notify()` 发布，Trigger 只匹配并派发，不解释事件领域内容。

HTTP 与 GitHub source 是当前 Trigger Plugin 内置的 ingress adapter。HTTP 外部调用固定
`POST /triggers/invoke`，携带 `Authorization: Trigger <secret>` 和
`{ triggerId, idempotencyKey, payload }`。SQLite 只保存该 HTTP delivery，不保存明文
secret。Trigger 先验证定义、secret、body 和 idempotency key，再以
`(triggerId, idempotencyKey)` 原子创建 delivery；首次接收调用 `context.dispatch()`，重复
调用返回已有 delivery，不再次派发。admission 失败持久化为 `failed`，不自动重试。

GitHub webhook 固定投递到 `POST /triggers/github`。它要求 `X-GitHub-Event`、
`X-GitHub-Delivery` 与 `X-Hub-Signature-256`；签名针对原始 JSON body 用每条 GitHub
source 的 secret 校验。相同 delivery 会按 Trigger binding 去重；签名有效但没有匹配
`event/action` 的消息返回 `202` 并忽略，避免 GitHub 重试无关事件。

`studio_event` binding 没有独立 durable queue：它响应一次已经发生的 Studio event。事件源
自身需要 durability/replay 时，应由其 owning Plugin 提供；Trigger 不复制 Kanban、GitHub
或其他领域的事实源。

管理 API `GET /triggers` 与 `GET /triggers/events` 使用 Studio Bearer；外部 invoke route
声明 route-owned authentication，由 Trigger 自己验证 secret。HTTP Plugin 只提供这一
通用鉴权策略，不读取 Trigger 配置。

## Pet 与事件

Plugin 在 `start()` 时通过 `listPets()` 验证目标 Pet。运行中所有 dispatch 都使用标准
`context.dispatch()`，所有事件只包含领域 identity/status，不向 Agent execution metadata
注入 scheduler/trigger/kanban 字段。
