# Session Projection

> **状态：当前中文概览。** 完整协议与类型在英文当前契约中维护。

[English](../../../reference/runtime/session-projection.md)

不要混用以下概念：

- **Checkpoint** 是对话消息和待继续执行的持久权威。
- **Snapshot** 是某一 checkpoint 时刻的物化值。
- **Timeline** 是 UI 呈现 session 的有序容器。
- **Session projection** 是客户端消费的、与 transport 无关的当前视图；它不是第二份对话存储。

客户端在启动、重连、审核刷新或消息完成后应用 snapshot。运行中的 tool / subagent 项目可以出现在 live timeline 中，但不必存在于持久 snapshot；不要试图用短暂事件流重建 durable state。

详细 snapshot version、review state、resume 与 transport 边界请阅读[完整 Session Projection 契约](../../../reference/runtime/session-projection.md)。
