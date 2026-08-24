# Studio HTTP Plugin

[English](../../studio/http-plugin.md)

`@pinpawo-plugin/studio-http` 是一个可选、零 Toolkit 的 Studio Plugin。它提供
loopback HTTP dispatch 入口、只读 Studio Pet 注册表，并把 Studio Plugin event bus 投射成 live SSE。它不提供
内置领域页面，但会暴露 route hook 供其他 Plugin 贡献页面或 API；它也不是 Studio
Host 自己的 WebSocket/stdio transport。

## 装配

```ts
import { createStudioHttpPlugin } from '@pinpawo-plugin/studio-http';

const plugin = createStudioHttpPlugin({
  port: 3212,
  authToken: process.env.STUDIO_HTTP_TOKEN!,
  allowedOrigins: ['http://localhost:3000'],
});
```

应用 resolver 为配置中的 Plugin ID 返回这个实例。server 固定监听 `127.0.0.1`；
`port: 0` 可在嵌入或测试时申请临时端口。两个入口都要求
`Authorization: Bearer <token>`。浏览器请求还必须来自 `allowedOrigins` 中显式列出的
精确 origin。

## Dispatch

```http
POST /dispatch
Authorization: Bearer ...
Content-Type: application/json

{
  "petId": "planner",
  "input": { "kind": "request", "request": "plan this work" },
  "idempotencyKey": "retry-1"
}
```

接受成功立即返回 `202` 和 `petId/threadId/invocationId`。只有调用方显式提供可选
`metadata` 时才会原样透传并回显；Plugin 不生成 HTTP、前端或 Kanban 专用的关联字段。
HTTP 连接不拥有 cancellation，也不等待 invocation completion。非法 JSON/dispatch
返回 `400`，错误 media type 返回 `415`，Studio 拒绝 dispatch 返回 `422`。

## Pet 注册表

```http
GET /pets
Authorization: Bearer ...
```

它返回当前 Studio Pet 注册表，包含 `petId`、name、role/service summary、startup/status 与
公开 Capability 摘要。注册表只读，刻意不包含 Agent 私有 actor 字段、runtime 引用、checkpoint
或 execution context；`/pets` 由 HTTP Plugin 自己拥有，不能被贡献 route 替换。

## Plugin 贡献的 route

HTTP Plugin 暴露由生命周期托管的 `routes` hook。其他已安装 Plugin 可以反向贡献
HTTP handler，HTTP 无需 import 或理解其领域。所有贡献 route 都经过相同的 Bearer
鉴权与 Origin 策略；`/dispatch`、`/pets` 和 `/events` 是保留路径。

同时安装 Kanban Plugin 时，它会贡献 `GET /kanban`，返回当前 task snapshot 与 event
cursor，并贡献 `GET /kanban/events` 读取 Kanban 自己的 durable task history。Kanban
在未安装 HTTP 时仍可独立启动，Plugin 启动顺序也不影响 hook 挂载。

## SSE live event

```http
GET /events
Authorization: Bearer ...
Accept: text/event-stream
```

每条 Studio Plugin event 形如：

```text
event: studio.event
data: {"type":"task.done","source":"kanban","payload":{...},"occurredAt":"..."}
```

原生 `EventSource` 不能设置 Bearer header，因此浏览器应通过 streaming `fetch` 消费
SSE。该 feed 只提供 live event：没有 durable ID、`Last-Event-ID` replay，也不包含
invocation progress；断线期间的 Plugin event 可能丢失。

生命周期、限制与安全不变量见 [HTTP Plugin 设计](../../design/studio/http-plugin.md)。
