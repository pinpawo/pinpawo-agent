# Capability / Toolkit 契约

> **状态：当前中文契约入口。** 详细规范目前已经以中文维护在主 Reference 页面。

[English navigation](../../../reference/extensions/capability-toolkit.md)

Capability 是可委派的业务任务单元：它声明 instructions 与完整 Toolkit allowlist。Toolkit 是 typed code：它提供工具、可用性、操作元数据、审核策略，以及可选 runtime 生命周期。

关键规则：

1. Capability 不声明或继承任意工具；它只通过 `uses` 引用 Toolkit。
2. `uses` 是完整权限边界，缺失已声明 Toolkit 时 Capability 不可用。
3. `CAPABILITY.md` 承载 task metadata 与 Markdown instructions；可选 `entry` 只能实现确定性的 `lifecycle.finalize`。
4. Toolkit runtime 不能改变静态 tool inventory、schema、description 或 review policy。

阅读[完整 Capability / Toolkit V2 契约（中文）](../../../reference/extensions/capability-toolkit.md)，并使用[Capability 目录协议（中文）](../../../reference/extensions/capability-directory.md)创建本地扩展。
