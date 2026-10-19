# Studio Automation Plugins

> 状态：当前实现边界
> 更新：2026-10-05

Scheduler 与 Trigger 是两个可选 Studio Plugin。Scheduler 表达时间条件；Trigger
表达“满足某个事件源条件时，向哪个 Pet 派发什么请求”。二者只通过
`StudioPluginContext.dispatch()` 向 Pet 提交单向输入，通过 `notify()` 发布领域事件。

Trigger 的 `request` 可以是静态字符串，也可以是有限的 request template。模板只把规范化
Trigger envelope 投射成一条 dispatch request；它不选择 Capability、Toolkit、模型、thread
或 Agent prompt。结构化形式支持 `{{payload.taskId}}` 这类无逻辑点路径替换，并通过
`context` 显式选择附加字段。它不提供条件、循环或任意表达式，也不会默认把完整 GitHub
payload 塞给 Agent。静态字符串继续保留原有的“固定 request + 完整 Trigger context”兼容语义。


```json
{
  "request": {
    "template": "Inspect change {{payload.changeId}} after {{event.type}}.",
    "context": ["payload.changeId", "payload.note", "event.occurredAt"]
  }
}
```

领域 Service 是 committed-mutation 的唯一出口。Plugin 订阅这个出口并统一投射 Studio
event；HTTP route、应用代码或其他 adapter 调用 Service 时不各自补发事件。

```text
Scheduler store -> due claim -> context.dispatch()
Scheduler store -> due claim (channelId) -> Channel `inputs.run()` -> Pet's Channel session
event source -> Trigger binding condition -> context.dispatch()
event source -> Trigger binding condition (channelId) -> Channel `inputs.run()` -> Pet's Channel session

Scheduler/Trigger -X-> Agent / thread / checkpoint / Agent Session
Scheduler/Trigger -X-> another Plugin database or service（Channel 的 `inputs` hook 除外）
Studio core       -X-> Scheduler/Trigger concrete package
```

Channel 是对话和结果的汇集处。schedule / trigger 是 Pet 的自发行为，本身不是 Channel 成员或发言者。
规则配置了 `channelId` 时，Trigger 不再自己 dispatch，而是调用 Channel Plugin 暴露的 `inputs` hook：
`run(channelId, petId, request, {kind:'trigger', id: triggerId}, {idempotencyKey})`。Channel 只校验目标 Pet
是该 Channel 的成员，然后在 `(channel, pet)` 绑定的 session、带 `channel` scope 派发
`{type:'channel_task', version:1, channelId, origin, body}`。指令不写入 Channel；Pet 随后的公开回复照常以
Pet 身份成为 Channel 消息，其中的 @ 照常交接。指令不是消息，正文里的寻址链接不会投递给任何成员。
`run()` 返回 Host 回执（invocationId、sessionId），Trigger 存在 delivery 记录的 `receipt` 里。
Channel 是软依赖：没有安装或没有启动 Channel Plugin、或 Pet 不是成员时，这类 delivery 记为 failed，
并不会退回到无 session 的 dispatch。没有 `channelId` 的规则保持原来的直接 dispatch，同样保存回执。

两个 Plugin 都可向 HTTP Plugin 的 `routes` hook 贡献 API，但不依赖 HTTP 才能启动。
HTTP 只承载 request/response；领域校验、幂等、持久化和 recovery 由贡献 route 的 Plugin
负责。

## Scheduler 第一版

第一版支持 durable one-shot schedule：`scheduleId/petId/request/runAt/status`。启动时把所有
已到期且仍为 `scheduled` 的记录视为 missed fire，并按原计划只 claim/dispatch 一次。
一次带条件的更新（只在仍是 `scheduled` 时生效）先把记录转成 `dispatching`，所以多个 Studio 共用一个数据库时
同一条 schedule 只会被 claim 一次；然后调用 `context.dispatch()`；接受后
标记 `dispatched`，表示 resident queue 已接纳而不是 Agent 执行完成；admission 失败标记
`failed`。崩溃遗留的 `dispatching` 标记为
`failed`，避免无法证明安全时重复派发。

schedule 可以带可选的 `channelId`。带了它的 schedule 到期后不直接 dispatch，而是和
Trigger 一样调用 Channel 的 `inputs.run()`（origin `{kind:'scheduler', id: scheduleId}`），Pet 在该 Channel 的
session 里执行，它的公开回复落在 Channel 里。Channel Plugin 没有运行或 Pet 不是成员时，这条 schedule 标记
`failed`，不退回直接 dispatch。没有 `channelId` 的 schedule 行为不变。两种情况都把 Host 回执保存为 schedule 的
`receipt`。

Scheduler 的数据在 [Studio 存储](storage.md)里（表 `schedules`、`schedule_events`，迁移 `0001_schedules`），
SQLite 和 Postgres 都可以；接口是 `ScheduleStore`（`plugins/scheduler/src/store/`）。以前的 `scheduler.sqlite`
不读取。Scheduler 等 Studio core 发布 `plugins.activated`（所有 Plugin 启动完成）后才开始处理到期
schedule，所以停机期间到期的 channel-bound schedule 不会因为 Channel Plugin 启动得比它晚而失败。

管理 API：

- `GET /scheduler`：snapshot；
- `POST /scheduler`：创建 `{ petId, request, runAt }`；
- `POST /scheduler/control`：`cancel` 尚未 claim 的 schedule；
- `GET /scheduler/events`：durable history cursor。

周期/cron、时区规则、重试和复杂 missed-fire policy 留到后续；第一版不自己实现 cron
parser。

## Trigger 第一版

一个 Trigger 是一条独立绑定：`source condition -> petId + request`。第一版有三种 source：

- `http`：一个具名外部 HTTP source；
- `github`：经 GitHub `X-Hub-Signature-256` 签名验证的 webhook，并可按 GitHub
  `event` 与 payload `action` 条件匹配；
- `studio_event`：Studio event bus 上匹配 `eventSource` 及精确 `type` 或 `typePrefix`
  的事件。

因此由已配置 Plugin 发布的事件或 GitHub `pull_request.*` 事件，都可以
作为 Trigger 的条件；它们不需要为“什么时候 dispatch”各自实现一个薄插件。外部事件源
由其 owning Plugin 通过 `notify()` 发布，Trigger 只匹配并派发，不解释事件领域内容。

HTTP 与 GitHub source 是当前 Trigger Plugin 内置的 ingress adapter。HTTP 外部调用固定
`POST /triggers/invoke`，携带 `Authorization: Trigger <secret>` 和
`{ triggerId, idempotencyKey, payload }`。存储只保存该 HTTP delivery，不保存明文
secret。Trigger 先验证定义、secret、body 和 idempotency key，再以
`(triggerId, idempotencyKey)` 原子创建 delivery；首次接收调用 `context.dispatch()`，重复
调用返回已有 delivery，不再次派发。admission 失败持久化为 `failed`，不自动重试。

Trigger 的数据在 [Studio 存储](storage.md)里（表 `trigger_deliveries`、`trigger_delivery_events`，迁移
`0001_trigger_deliveries`），SQLite 和 Postgres 都可以；接口是 `TriggerStore`（`plugins/trigger/src/store/`），
规则在 `TriggerService`。`(triggerId, idempotencyKey)` 唯一约束让共用一个数据库的多个 Studio 也只创建一条
delivery；状态变化是条件更新。启动时仍是 `dispatching` 的 delivery 标记为 `failed`（结果未知），可由操作者重试。
以前的 `trigger.sqlite` 不读取。

GitHub webhook 固定投递到 `POST /triggers/github`。它要求 `X-GitHub-Event`、
`X-GitHub-Delivery` 与 `X-Hub-Signature-256`；签名针对原始 JSON body 用每条 GitHub
source 的 secret 校验。相同 delivery 会按 Trigger binding 去重；签名有效但没有匹配
`event/action` 的消息返回 `202` 并忽略，避免 GitHub 重试无关事件。

`studio_event` binding 没有独立 durable queue：它响应一次已经发生的 Studio event。事件源
自身需要 durability/replay 时，应由其 owning Plugin 提供；Trigger 不复制其他领域、GitHub
或其他领域的事实源。
`studio_event` delivery 的 idempotency key 是 `studio:<source>:<type>:<id>`：payload 带
`sequence`（如 Scheduler 的持久序号）时用它，重启后同一事件仍去重；否则用 Studio 在
`notify()` 时分配的 `eventId`，同一毫秒的两个不同事件各派发一次。

Trigger source 负责“何时触发”，request template 负责“发送什么”，`petId` 负责“发给谁”，
`channelId` 负责“结果落在哪个 Channel”。
宽泛的 `typePrefix` 会为每个匹配 mutation 产生一次独立 dispatch；需要昂贵 Agent 工作时，
配置应优先选择明确的领域终态事件，而不是依赖 Trigger 隐式 debounce 或合并队列。

管理 API `GET /triggers` 与 `GET /triggers/events` 使用 Studio Bearer；外部 invoke route
声明 route-owned authentication，由 Trigger 自己验证 secret。HTTP Plugin 只提供这一
通用鉴权策略，不读取 Trigger 配置。

## Pet 与事件

Plugin 在 `start()` 时通过 `listPets()` 验证目标 Pet。运行中所有 dispatch 都使用标准
`context.dispatch()`，所有事件只包含领域 identity/status，不向 Agent execution metadata
注入 scheduler/trigger/channel 字段。

## Kanban 退役后的默认装配

默认仅保留外部请求 → Executor 的显式 HTTP 规则；Wiki 更新需要明确请求，
不以 dispatch.completed 替代交付验收。旧规则迁移见[配置](../../studio/configuration.md#retired-kanban-workdirs)，
可选周期队列巡检见[Queue Notices](../studio-dispatch-queue-notices.md)。
