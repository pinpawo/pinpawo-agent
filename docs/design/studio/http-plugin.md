# Studio HTTP Plugin

> 状态：Draft implementation contract
> 更新：2026-08-23

HTTP 是一个具体 `StudioPlugin`，不是 Studio Host transport，也不是 Studio core 的
内置 server。它把 dispatch/event 通道投射到 HTTP，并暴露 HTTP-owned route hook：

```text
POST /dispatch  ──> context.dispatch(request) ──> receipt identity
                              │
                              └─ receipt.onInvocation() ──> HTTP dispatch read model

GET /dispatches <──────────────────────────────────────────┘

context.subscribe(event)
        └─────────> GET /events (SSE) ──────────> frontend

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
  "input": { "kind": "request", "request": "plan this work" },
  "idempotencyKey": "optional-retry-key"
}
```

HTTP Plugin 校验结构后调用 `context.dispatch()`。接受成功返回 `202` 和
`petId/threadId/invocationId`；仅当调用方显式提供可选 `metadata` 时才原样回显它。
Plugin 不为 HTTP、前端或 Kanban 生成额外关联字段。它不等待 invocation completion，
也不把 HTTP 连接变成 cancellation owner。

### `GET /dispatches`

HTTP Plugin 为自己通过 `context.dispatch()` 发出的 invocation 维护有界内存 read model：

```text
queued -> busy -> completed | waiting | failed | cancelled
```

`queued` 来自已接受但 receipt 尚未出现 invocation progress；后续状态只消费该 receipt 的
`onInvocation()`。read model 不读取 Pet、checkpoint 或 Studio 内部 queue，也不观察其他
Plugin 派出的 invocation。更新同时作为 `dispatch.updated` 投射到 HTTP 自己的 SSE 客户端；
重连后由 `GET /dispatches` 恢复快照。该状态不持久化，Plugin 重启即清空。

### `GET /events`

该入口把 `context.subscribe()` 收到的 `StudioEvent`，以及 HTTP 自己的
`dispatch.updated` read-model 更新，作为 `studio.event` SSE 推送。
这是 live-only feed：

- 不生成 durable event id；
- 不实现 `Last-Event-ID` replay；
- 断线期间的事件会丢失；
- heartbeat 只是连接保活，不改变 event 语义。

durable event log、断线重放和按用户建立 event cursor 需要独立设计，不能由内存 SSE
连接假装提供。

### `routes` hook

HTTP Plugin 在自己的 `StudioPluginContext.hooks` 上暴露 `routes`。贡献方注册
`method + absolute path + handler`，HTTP 统一负责监听、可选 Bearer 鉴权、Origin/CORS、
body 上限和响应发送。内置 `/dispatch`、`/dispatches` 与 `/events` 是保留路径，贡献方不能覆盖。

Kanban 默认向名为 `http` 的 Plugin 贡献 `GET /kanban`，返回当前 task snapshot（含
`lastEventSequence`），并贡献 `GET /kanban/events` 读取 Kanban 自己的 durable history。
它可以在没有 HTTP Plugin 时独立运行：hook contribution 会保持未挂载状态，不会让
Kanban 启动失败。Plugin 启动顺序也不影响挂载；任一方停止时，Studio 托管的 hook
lifecycle 会移除 route。

## 2. Security boundary

- server 只监听 `127.0.0.1`；当前 Plugin 不提供公网 bind 配置；
- dispatch 与 SSE 默认无需认证；嵌入方提供 `authToken` 后才要求 Bearer token。启用后 SSE
  前端使用支持自定义 header 的 streaming `fetch`，不把 token 放入 query string；
- 浏览器携带 `Origin` 时必须命中 Plugin 自己的 loopback origin 或显式 `allowedOrigins`；Plugin
  处理受限 CORS preflight；
- POST body 有明确字节上限；SSE client 数量有上限；慢客户端背压治理仍须在 HTTP Plugin
  内收紧，不能由 Kanban 或 Studio core 处理；
- Plugin 贡献的 route 进入同一可选认证与 Origin 边界，不能绕过 HTTP Plugin 统一策略；
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
- 观察其他 Plugin 派出的 invocation 或建立 Studio 全局 durable invocation history；
- Plugin discovery/安装；
- pending-interrupt interaction UI；
- durable event storage/replay；
- HTTP Toolkit 或 Agent Capability。
