# Studio HTTP Plugin

> 状态：Draft implementation contract
> 更新：2026-08-27

HTTP 是一个具体 `StudioPlugin`，不是 Studio core 的内置 server。目标 Studio Host
composition 把它作为唯一 control-plane transport 装配；它把 dispatch/event 通道投射到
HTTP，并暴露 HTTP-owned route hook：

```text
POST /dispatch  ──> context.dispatch(request) ──> receipt identity

Studio core event bus ──> context.subscribe(event)
                                └─> GET /events (live SSE) ──> HTTP client

Kanban Plugin ──contribute──> http/routes hook ──> GET /kanban
```

实现使用 Hono 与 `@hono/node-server` 处理 router、middleware、body limit、CORS 和
SSE response；这些都是 HTTP Plugin 的内部依赖。Studio 和贡献 route 的 Plugin 只依赖本
文的 HTTP contract，不感知该实现选择。

该 Plugin 定义零个 Toolkit，不注册 Capability，也不依赖 Kanban 或其他 Plugin。
它只暴露 HTTP-owned `routes` hook；具体 Plugin 可以反向贡献 route，HTTP 不解释
route 背后的领域。

## 1. HTTP contract

### `POST /dispatch`

请求体就是 transport-neutral `StudioDispatchRequest` 的 JSON 形态：

```json
{
  "petId": "planner",
  "request": "plan this work",
  "idempotencyKey": "optional-retry-key"
}
```

HTTP Plugin 校验结构后调用 `context.dispatch()`。接受成功返回 `202` 和
`petId/invocationId`；仅当调用方显式提供可选 `metadata` 时才原样回显它。
Plugin 不为 HTTP、前端或 Kanban 生成额外关联字段，也不等待 Agent execution；Studio
receipt 本身就没有 completion，HTTP 连接也不是 cancellation owner。
调用方如需观察 Agent 执行，应连接目标 Pet 的 Agent Session event stream。Plugin 领域状态
仍通过各自的 snapshot/history/event 暴露，不能从 dispatch receipt 推导。

### `GET /events`

该入口是 Studio core event bus 的普通 subscriber。HTTP Plugin 不拥有 event queue，也不
建立 Plugin 间的第二条总线；它只把 `context.subscribe()` 收到的 `StudioEvent` 编码为
`studio.event`，广播给当前 SSE client。Plugin 间的发布与订阅统一通过
`StudioPluginContext.notify/subscribe`。

这是 live-only projection：不生成 durable event id，不实现 `Last-Event-ID` replay，断线
期间的 event 会丢失。heartbeat 只是 HTTP transport 保活，不进入 Studio event bus。
Kanban Console 每次重连都重新读取 Kanban 自己的 snapshot/history；Kanban 的 SQLite
仍是 task 事实源，HTTP Plugin 不拥有数据库或领域 history。

Studio core 为每个 subscriber 隔离 FIFO delivery；HTTP 的异步 SSE 写入只阻塞 HTTP
subscriber 自己，不阻塞其他 Plugin。Studio 还会按 Plugin lifecycle owner 自动释放该
subscription，HTTP Plugin 保留显式退订仅用于及时清理自己的 transport 资源。

### `routes` hook

HTTP Plugin 在自己的 `StudioPluginContext.hooks` 上暴露 `routes`。贡献方注册
`method + absolute path + handler`，HTTP 统一负责监听、Bearer 鉴权、Origin/CORS、
body 上限和响应发送。内置 `/dispatch` 与 `/events` 是保留路径，贡献方不能覆盖。

Kanban 默认向名为 `http` 的 Plugin 贡献 `GET /kanban`，返回当前 task snapshot（含
`lastEventSequence`），并贡献 `GET /kanban/events` 读取 Kanban 自己的 durable history。
它可以在没有 HTTP Plugin 时独立运行：hook contribution 会保持未挂载状态，不会让
Kanban 启动失败。Plugin 启动顺序也不影响挂载；任一方停止时，Studio 托管的 hook
lifecycle 会移除 route。

## 2. Security boundary

- server 只监听 `127.0.0.1`；当前 Plugin 不提供公网 bind 配置；
- dispatch 与 SSE 都要求 Bearer token；SSE client 使用支持自定义 header 的 streaming
  `fetch`，不把 token 放入 query string；
- client 携带 `Origin` 时必须命中显式 `allowedOrigins`；Plugin 处理受限 CORS preflight；
- POST body 有明确字节上限；SSE client 数量有上限；慢客户端背压治理仍须在 HTTP Plugin
  内收紧，不能由 Kanban 或 Studio core 处理；
- Plugin 贡献的 route 进入同一 Bearer 与 Origin 边界，不能绕过 HTTP Plugin 鉴权；
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
