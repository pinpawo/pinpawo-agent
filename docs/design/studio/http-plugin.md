# Studio HTTP Plugin

> 状态：当前实现边界
> 更新：2026-10-05

HTTP 是一个具体 `StudioPlugin`，不是 Studio core 的内置 server。目标 Studio Host
composition 把它作为唯一 control-plane transport 装配；它把 dispatch/event 通道投射到
HTTP，并暴露 HTTP-owned route hook：

```text
POST /dispatch  ──> context.dispatch(request) ──> receipt identity

Studio core event bus ──> context.subscribe(event)
                                └─> GET /events (live SSE) ──> HTTP client

Channel Plugin ──contribute──> http/routes hook ──> /channels APIs
Scheduler/Trigger ──contribute──> http/routes hook ──> domain APIs
```

实现使用 Hono 与 `@hono/node-server` 处理 router、middleware、body limit、CORS 和
SSE response；这些都是 HTTP Plugin 的内部依赖。Studio 和贡献 route 的 Plugin 只依赖本
文的 HTTP contract，不感知该实现选择。

该 Plugin 定义零个 Toolkit，不注册 Capability，也不依赖其他具体 Plugin。
它只暴露 HTTP-owned `routes` hook；具体 Plugin 可以反向贡献 route，HTTP 不解释
route 背后的领域。

## 1. HTTP contract

### `GET /dispatch/queues`

使用现有 Studio Bearer，直接转发 `context.listDispatchQueues()` 的只读全局投影。
队列来自原 resident Coordinator，不在 HTTP 保存或估算。条目只含 dispatch 身份、
入队时间与已有 session/scope 关联，不含请求正文或模型内容。缺少观察 port 时返回
`503`，不制造空闲或空队列；不支持通过这个接口修改队列。

### `/pet-sessions/*`（#923）

使用现有 Studio Bearer，经 `context.petSessions` 转发 Host 的 `PetSessionPort`，
按 `petId + sessionId` 精确寻址；未知 Pet/session 返回 `404`，绝不回落到 active
session，也不创建 session。缺少端口时返回 `503`。

- `GET /pet-sessions/snapshot?petId&sessionId`：该 session 的版本化 `AgentSessionSnapshot`。
- `GET /pet-sessions/events?petId&sessionId`：SSE `agent.session`，首帧
  `session.snapshot.result`，之后只有该 session 的 `AgentServerMessage`；与 `/events`
  共用连接上限，不占用 TUI 的交互连接。
- `POST /pet-sessions/review`：只接受
  `{petId, sessionId, requestId, interruptId, value: {decisions}}`；其他命令（chat、
  session.resume、cancel 等）一律 `400`。`202` 只表示 Host 接手，结果（包括接手后的
  失败）在该 session 的事件流里按 requestId 返回。Host 当场能判定的拒绝返回 `409`：
  审批已不是该 session 当前的（`review_closed`），或该 Pet 正在运行（含另一个正在续跑
  的应答，`session_busy`）。两个窗口同时应答时，第二个直接收到 `409`。

### `POST /dispatch`

请求体是 `StudioWireDispatchRequest` 的 JSON 形态：

```json
{
  "petId": "planner",
  "request": "plan this work",
  "idempotencyKey": "optional-retry-key"
}
```

`StudioDispatchRequest` 的 `session` 与 `scope` 是 Host 信任的定向字段，只允许进程内
Plugin 直接设置；wire 形态不接受它们，携带即 `400`，否则 HTTP 调用方可借已知 session
把回复发布到其他 Plugin 的领域（如 Channel）。

HTTP Plugin 校验结构后调用 `context.dispatch()`。接受成功返回 `202` 和
`petId/invocationId`；仅当调用方显式提供可选 `metadata` 时才原样回显它。
Plugin 不为 HTTP、前端或领域 Plugin 生成额外关联字段，也不等待 Agent execution；Studio
receipt 本身就没有 completion，HTTP 连接也不是 cancellation owner。
调用方如需观察完整 Agent execution（消息、工具、review 或结果），应连接目标 Pet 的
Agent Session event stream。Studio event bus 转发与 receipt 关联的 dispatch lifecycle，
可含本轮请求、公开 reply 和 waiting 投影，仍不等于完整 Agent stream 或执行控制。
Console 可显示 queued/running/failed 并发起新的 retry dispatch；Console 只重试自己经 HTTP 直接发起的请求，Plugin-owned dispatch 由来源 Plugin
处理。它不能替代 Agent Session，也不能从 receipt 推导 Plugin 领域状态。

### `GET /events`

该入口是 Studio core event bus 的普通 subscriber。HTTP Plugin 不拥有 event queue，也不
建立 Plugin 间的第二条总线；它只把 `context.subscribe()` 收到的 `StudioEvent` 编码为
`studio.event`，广播给当前 SSE client。Plugin 间的发布与订阅统一通过
`StudioPluginContext.notify/subscribe`。

这是 live-only projection：不生成 durable event id，不实现 `Last-Event-ID` replay，断线
期间的 event 会丢失。heartbeat 只是 HTTP transport 保活，不进入 Studio event bus。
Console 每次重连都重新读取当前领域自己的 snapshot/history；Channel 的 SQLite
是 Channel 事实源，HTTP Plugin 不拥有数据库或领域 history。
Channel 的消息与可靠性边界见[统一设计](channel-addressing-and-execution.md)。

Studio core 为每个 subscriber 隔离 FIFO delivery；HTTP 的异步 SSE 写入只阻塞 HTTP
subscriber 自己，不阻塞其他 Plugin。Studio 还会按 Plugin lifecycle owner 自动释放该
subscription，HTTP Plugin 保留显式退订仅用于及时清理自己的 transport 资源。

### `routes` hook

HTTP Plugin 在自己的 `StudioPluginContext.hooks` 上暴露 `routes`。贡献方注册
`method + absolute path + handler`，HTTP 统一负责监听、Origin/CORS、body 上限和响应发送。
route 默认使用 Studio Bearer；外部 webhook 一类入口可以显式选择 route-owned auth，由
贡献方在 handler 中完成领域凭证验证。内置 `/dispatch`、`/events` 与 `/pets` 是保留路径，
贡献方不能覆盖。

Channel 向名为 `http` 的 Plugin 贡献 `/channels` 的目标、消息、执行与历史 API。
它可以在没有 HTTP Plugin 时独立运行：hook contribution 保持未挂载状态。
Plugin 启动顺序不影响挂载；任一方停止时，Studio 托管的 hook lifecycle 移除 route。
HTTP 不读取 Channel 数据库，也不拥有领域状态或恢复机制。

## 2. Security boundary

- server 只监听 `127.0.0.1`；当前 Plugin 不提供公网 bind 配置；
- dispatch 与 SSE 都要求 Bearer token；SSE client 使用支持自定义 header 的 streaming
  `fetch`，不把 token 放入 query string；
- client 携带 `Origin` 时必须命中显式 `allowedOrigins`；Plugin 处理受限 CORS preflight；
- POST body 有明确字节上限；SSE client 数量有上限；慢客户端背压治理仍须在 HTTP Plugin
  内收紧，不能由领域 Plugin 或 Studio core 处理；
- Plugin 贡献的管理 route 默认进入同一 Bearer 与 Origin 边界；route-owned auth 必须显式
  声明，且贡献方必须在 handler 中拒绝无效凭证；
- Plugin options 与 token 由外部 resolver/application composition root 提供，Studio
  config schema 不解释这些字段，也不读取 token。

## 3. Lifecycle

- `start(context)` 完成监听和 event subscription 后才成功；监听失败必须完整 rollback；
- `stop()` 先退订 Studio event，结束 SSE client，再关闭 HTTP server；可重复调用；
- Plugin instance 不能被并发或重复启动；实际分配端口通过只读 `address()` 暴露给
  application/tests，不进入 Studio contract。

## 4. 非目标

- Web UI、静态资源托管或同源页面装配；
- Agent Session conversation、pending interrupt projection 或 resume；
- invocation progress SSE；
- 观察其他 Plugin 派出的 invocation 或建立 Studio 全局 durable invocation history；
- Plugin discovery/安装；
- pending-interrupt interaction UI；
- durable event storage/replay；
- HTTP Toolkit 或 Agent Capability。
