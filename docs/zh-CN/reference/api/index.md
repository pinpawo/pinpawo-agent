# API 参考

> **状态：当前参考入口。** 具体类型以当前源码和每个边界页面为准。

[English](../../../reference/api/index.md)

| 集成目标 | 参考 |
|---|---|
| 调用单个 Pet runtime | [Pet Runtime（英文）](../../../reference/api/pet-runtime.md) |
| 协调多个 Pet | [Studio API（中文）](studio.md) |
| 编写任务扩展 | [Capability / Toolkit 契约](../extensions/capability-toolkit.md) |
| 渲染工具活动或审批界面 | [事件与人工审核（英文）](../../../reference/api/events-and-review.md) |
| 通过终端或进程运行 | [CLI 参考](cli.md) |
| 处理失败和遥测 | [错误处理（英文）](../../../reference/api/error-handling.md) |

Pet runtime 拥有单个 Agent 的执行、Capability 选择、工具调用、checkpoint 校验和审核继续；Studio 提供稳定 Pet thread、每 Pet invocation 串行、live invocation 投射和 Plugin 事件总线，不复制 worker 的私有工具或消息历史。任务依赖、进度、重试和持久化属于 Plugin 或 Host。checkpoint 是 pending continuation 的持久权威。
