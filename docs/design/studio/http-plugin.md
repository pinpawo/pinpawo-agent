# Studio HTTP Plugin

> 状态：Draft implementation contract
> 更新：2026-08-23

HTTP 是一个具体 `StudioPlugin`，不是 Studio Host transport，也不是 Studio core 的
内置 server。它把 dispatch/event 通道投射到 HTTP，并暴露 HTTP-owned route hook：

```text
POST /dispatch  ──> context.dispatch(request) ──> receipt identity

context.subscribe(event)
        └─────────> GET /events (SSE) ──────────> frontend

Kanban Plugin ──contribute──> http/routes hook ──> GET /kanban
```

该 Plugin 定义零个 Toolkit，不注册 Capability，也不依赖 Kanban 或其他 Plugin。
它只暴露 HTTP-owned `routes` hook；具体 Plugin 可以反向贡献 route，HTTP 不解释
route 背后的领域。

## 1. HTTP contract

### `POST /dispatch`

请求体就是 transport-neutral `StudioDispatchRequest` 的 JSON 形态：

```json
{
  "petId": "planner",
  "input": { "kind": "request", "request": "plan this work" },
  "idempotencyKey": "optional-retry-key"
}
```

HTTP Plugin 校验结构后调用 `context.dispatch()`。接受成功返回 `202` 和
`petId/threadId/invocationId`；仅当调用方显式提供可选 `metadata` 时才原样回显它。
Plugin 不为 HTTP、前端或 Kanban 生成额外关联字段。它不等待 invocation completion，
也不把 HTTP 连接变成 cancellation owner。调用方如需执行进度，应使用 Studio
invocation transport，而不是把 Plugin event 当成 invocation event。

### `GET /events`

该入口把 `context.subscribe()` 收到的 `StudioEvent` 作为 `studio.event` SSE 推送。
这是 live-only feed：

- 不生成 durable event id；
- 不实现 `Last-Event-ID` replay；
- 断线期间的事件会丢失；
- heartbeat 只是连接保活，不改变 event 语义。

durable event log、断线重放和按用户建立 event cursor 需要独立设计，不能由内存 SSE
连接假装提供。

### `routes` hook

HTTP Plugin 在自己的 `StudioPluginContext.hooks` 上暴露 `routes`。贡献方注册
`method + absolute path + handler`，HTTP 统一负责监听、Bearer 鉴权、Origin/CORS、
body 上限和响应发送。内置 `/dispatch` 与 `/events` 是保留路径，贡献方不能覆盖。

Kanban 默认向名为 `http` 的 Plugin 贡献 `GET /kanban`，返回当前 board snapshot。
它可以在没有 HTTP Plugin 时独立运行：hook contribution 会保持未挂载状态，不会让
Kanban 启动失败。Plugin 启动顺序也不影响挂载；任一方停止时，Studio 托管的 hook
lifecycle 会移除 route。

## 2. Security boundary

- server 只监听 `127.0.0.1`；当前 Plugin 不提供公网 bind 配置；
- dispatch 与 SSE 都要求 Bearer token；SSE 前端使用支持自定义 header 的 streaming
  `fetch`，不把 token 放入 query string；
- 浏览器携带 `Origin` 时必须命中显式 `allowedOrigins`；Plugin 处理受限 CORS preflight；
- POST body 有明确字节上限；SSE client 数量有上限；慢客户端遇到 backpressure 时断开；
- Plugin 贡献的 route 进入同一 Bearer 与 Origin 边界，不能绕过 HTTP Plugin 鉴权；
- Plugin options 与 token 由外部 resolver/application composition root 提供，Studio
  config schema 不解释这些字段，也不读取 token。

## 3. Lifecycle

- `start(context)` 完成监听和 event subscription 后才成功；监听失败必须完整 rollback；
- `stop()` 先停止接收 event，结束 SSE client，再关闭 HTTP server；可重复调用；
- Plugin instance 不能被并发或重复启动；实际分配端口通过只读 `address()` 暴露给
  application/tests，不进入 Studio contract。

## 4. 非目标

- HTTP Plugin 自己内置领域页面或静态资源；页面可由具体 Plugin 经 route hook 贡献；
- Studio Host 的 WebSocket/stdio invocation transport；
- invocation progress SSE；
- Plugin discovery/安装；
- pending-interrupt interaction UI；
- durable event storage/replay；
- HTTP Toolkit 或 Agent Capability。
