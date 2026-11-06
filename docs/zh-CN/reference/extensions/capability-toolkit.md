# Capability / Toolkit 契约

> **状态：当前中文契约入口。** 详细规范目前已经以中文维护在主 Reference 页面。

[完整契约（中文）](../../../reference/extensions/capability-toolkit.md)

Capability 是可委派的业务任务单元：它声明 instructions 与完整 Toolkit allowlist。Toolkit 是 typed code：它提供工具、可用性、操作元数据和审核策略，也可声明由 Host 注入的执行环境依赖（RS）。

关键规则：

1. Capability 不声明或继承任意工具；它只通过 `uses` 引用 Toolkit。
2. `uses` 是完整权限边界，缺失已声明 Toolkit 时 Capability 不可用。
3. `CAPABILITY.md` 承载 task metadata 与 Markdown instructions；可选 `entry` 只能实现确定性的 `lifecycle.finalize`。
4. Toolkit 的工具和策略在装配时确定；依赖 RS 的 Toolkit 通过 `requires` 声明依赖，由 Host 注入符合契约的实例。详见 [RS 依赖](../../../reference/extensions/toolkit-rs.md)。

旧 Artifact Pipeline 的 store/discovery、旧 state 索引与 Channel 消息附件接口已退役。
普通 finalize 仅保留 `output` 输出改写和只读 context `messages`；执行记录只支持现行契约。
扩展更新、历史 JSON 和 checkpoint 回收边界见
[退役说明](../../../reference/extensions/capability-toolkit.md#7-旧-artifact-pipeline-退役)。

阅读[完整 Capability / Toolkit V2 契约（中文）](../../../reference/extensions/capability-toolkit.md)，并使用[Capability 目录协议（中文）](../../../reference/extensions/capability-directory.md)创建本地扩展。
