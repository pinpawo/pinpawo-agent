# Agent Session HTTP / SSE

状态：Draft，2026-09-16。

为外部 coding agent 的 Studio skill 提供会话观察和审批入口。实现放在
local-agent 的 Agent Session listener，与 WebSocket 共用 Pet registry、鉴权、
协议解析、snapshot、审批校验和 conversation coordinator。Studio Plugin 不依赖会话协议。

## 接口

基址为 Agent Session 端口（默认 3212），不是 Studio Plugin HTTP 端口（3211）。
所有请求使用现有 Bearer token，并保留 Origin 校验。

- GET `/agent-session/pets/:petId/snapshot`：现有 snapshot result envelope，加 `queue`。
- GET `/agent-session/pets/:petId/events`：SSE，`event: message`，data 为现有
  AgentServerMessage。仅直播，无持久重放；订阅后读取 snapshot，断线后重新读取。
- POST `/agent-session/pets/:petId/messages`：现有 AgentClientMessage JSON，要求
  requestId；返回 202 表示接收，执行结果通过 SSE / snapshot 观察，不代表完成。
  包括 `interrupt.resume`，value 保持由 interrupt kind 定义，不增加审批 REST schema。

## 所有权

WebSocket 保留单交互客户端约束。HTTP 命令使用 Host 持有的 peer，经过相同的
conversation gate；SSE 是多读者，不调用 connect/disconnect。HTTP 请求或 SSE
断开不停止命令。Host 关闭会清理 Host peer 的运行。
`run.interrupt` 按 requestId 定位该 Pet 的运行，TUI 与 HTTP 可以互相停止运行，
不会因为发起连接不同而失效；停止不等于批准待处理的 review。

运行事件向 TUI 和 SSE 广播；Host peer 的协议响应也广播。GET snapshot 的结果
只返回调用者。多个审批提交仍由 runtime 的 interrupt id / 当前状态校验决定。
不新增第二套审批状态，不通过写 checkpoint 恢复，不把 dispatch 当作审批恢复。

## 边界

本轮不增加事件持久化、自动重试、自动放行策略或调度依赖。202 后客户端不得
盲目重发有副作用的命令，应通过 snapshot 核对。请求体限 1 MiB；慢 SSE 消费者
断开后靠 snapshot 恢复。skill 读取实际 review 选项，不推断或硬编码批准 ID。

后续如需跨重启的命令去重和事件重放，应单独设计持久化边界。
