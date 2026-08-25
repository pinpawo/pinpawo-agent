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
  allowedOrigins: ['http://localhost:3000'],
});
```

应用 resolver 为配置中的 Plugin ID 返回这个实例。server 固定监听 `127.0.0.1`；
`port: 0` 可在嵌入或测试时申请临时端口。默认 loopback 调用不需要认证；嵌入方需要
Bearer 边界时才传入 `authToken`，此时 dispatch、SSE 和贡献 route 要求
`Authorization: Bearer <token>`。跨 origin 浏览器请求仍必须来自 `allowedOrigins` 中
显式列出的精确 origin；Plugin 自己的 loopback origin 始终允许。

## Dispatch

```http
POST /dispatch
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

`GET /dispatches` 返回由这个 HTTP Plugin 接受的 dispatch 的有界内存 read model。
记录从 `queued` 开始，Pet invocation 启动后变成 `busy`，最终进入 `completed`、
`waiting`、`failed` 或 `cancelled`。它用于 Console 可观察性，不是 Studio 的 durable
queue：Plugin 重启后会清空，其他 Plugin 发出的 dispatch 仍由各自领域投射负责展示。

## Pet 注册表

```http
GET /pets
```

它返回当前 Studio Pet 注册表，包含 `petId`、name、role/service summary、startup/status 与
公开 Capability 摘要。注册表只读，刻意不包含 Agent 私有 actor 字段、runtime 引用、checkpoint
或 execution context；`/pets` 由 HTTP Plugin 自己拥有，不能被贡献 route 替换。

## Plugin 贡献的 route 与静态 UI

HTTP Plugin 暴露由生命周期托管的 `routes` hook。其他已安装 Plugin 可以反向贡献
HTTP handler，HTTP 无需 import 或理解其领域。所有贡献 route 都经过相同的可选认证与
Origin 策略；`/dispatch`、`/dispatches`、`/pets` 和 `/events` 是保留路径。

同时安装 Kanban Plugin 时，它会贡献 `GET /kanban`，返回当前 task snapshot 与 event
cursor，并贡献 `GET /kanban/events` 读取 Kanban 自己的 durable task history。Kanban
在未安装 HTTP 时仍可独立启动，Plugin 启动顺序也不影响 hook 挂载。

独立的 `static` hook 接受预打包 asset provider，而不是浏览器传入的文件系统路径。
`@pinpawo-plugin/kanban/console/studio-plugin` 是零 Toolkit Plugin，会把自己的 Vite
bundle 挂在 `/`；它不会启动第二个 server，浏览器同源调用 `/kanban`、`/pets`、`/events`、`/dispatches`
和 `/dispatch`。静态 mount 随 Plugin lifecycle 管理，Console Plugin 停止时文件也会卸载。

## SSE live event

```http
GET /events
Accept: text/event-stream
```

每条 Studio Plugin event 形如：

```text
event: studio.event
data: {"type":"task.done","source":"kanban","payload":{...},"occurredAt":"..."}
```

HTTP Plugin 还会把自己的 dispatch read model 更新作为 `dispatch.updated` 消息投射到
同一 live stream。客户端首次连接或重连后用 `GET /dispatches` 恢复当前状态。

未启用认证的 loopback 客户端可用原生 `EventSource` 消费 SSE；嵌入方启用 Bearer 后，
原生 `EventSource` 不能设置 header，应改用 streaming `fetch`。该 feed 只提供 live
event：没有 durable ID 或 `Last-Event-ID` replay；断线期间的消息可能丢失，所以 dispatch
snapshot 与各领域自己的 history 才是恢复路径。

生命周期、限制与安全不变量见 [HTTP Plugin 设计](../../design/studio/http-plugin.md)。
