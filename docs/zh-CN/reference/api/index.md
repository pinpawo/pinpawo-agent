# API 参考

> **状态：当前参考入口。** 具体类型以当前源码和每个边界页面为准。

[English](../../../reference/api/index.md)

| 集成目标 | 参考 |
|---|---|
| 装配 resident Pet Host | [Resident Pet Host ports](../../../design/agent-runtime/resident-pet-host-ports.md) |
| 协调多个 Pet | [Studio API](../../../reference/api/studio.md) |
| 编写任务扩展 | [Capability / Toolkit 契约](../extensions/capability-toolkit.md) |
| 渲染工具活动或审批界面 | [事件与人工审核（英文）](../../../reference/api/events-and-review.md) |
| 通过终端或进程运行 | [CLI 参考](cli.md) |
| 处理失败和遥测 | [错误处理（英文）](../../../reference/api/error-handling.md) |

Resident Pet runtime 拥有 Agent 执行、Capability 选择、工具调用与 checkpoint；Studio
只提供单向 dispatch、每 Pet invocation 串行、live invocation 投射和 Plugin 事件总线。
active thread 与审核恢复属于 local-agent Agent Session，任务依赖、重试和持久化属于 Plugin。
