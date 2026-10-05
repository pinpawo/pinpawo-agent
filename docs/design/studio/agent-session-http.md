# Agent Session HTTP / SSE

状态：当前 Host adapter 边界，2026-10-05。

为外部 coding agent 的 Studio skill 提供会话观察和审批入口。实现放在
host 的 Agent Session listener，与 WebSocket 共用 Pet registry、鉴权、
协议解析、snapshot、审批校验和 conversation coordinator。Studio Plugin 不依赖会话协议。

## 接口

路由、payload、端口与响应集中在 [Studio API](../../reference/api/studio.md#host-agent-session-http)。
Agent Session 端口默认 3212，独立于 Studio Plugin HTTP 3211；共用现有 Bearer、Origin
和协议校验。202 只表示接纳，SSE 无重放，断线后重读 snapshot，不盲目重发变更。

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
