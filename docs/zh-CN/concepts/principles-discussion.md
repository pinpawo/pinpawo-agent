# 项目核心理念：讨论起点

> **状态：待讨论。** 本页用于和项目维护者逐项对齐，不是已经确认的理念清单，也不修改现有运行契约。

## 为什么回看

现有文档把项目希望解决的问题、已接受的设计和具体实现放得较近。例如，[核心概念](core-concepts.md)同时介绍用户价值、Capability 与 checkpoint；[架构](architecture.md)的设计目标也直接引用了现有组件。这些内容有助于理解当前系统，但仅凭代码已经这样实现，不能证明它应当成为长期理念。

已确认的是这次文档工作的方向：重新审视被开发和代码设计牵引的表述，并逐步与项目维护者对齐核心理念。下面的问题和资料是讨论材料，不预设答案。

## 建议逐项讨论

1. **项目服务谁，要帮助他们完成什么工作？** 什么结果能说明 Agent 真正帮到了用户？先从具体场景和结果讨论，再判断需要哪些能力。
2. **模型和程序如何分工？** 哪些判断应留给模型结合上下文处理，哪些权限、协议或恢复边界需要程序保障？遇到不确定或失败时，用户希望 Agent 如何推进、何时停下来？
3. **什么值得成为长期理念，什么只是可替换的实现？** 对照已有的 Pet、Capability、Toolkit、Host、Studio 等词汇，哪些帮助用户理解问题，哪些只解释当前代码？普通 helper 应在什么情况下进入公共概念？
4. **如何验收这些理念？** 对用户可见的结果、过程透明度、控制权和可恢复性分别有什么期望？哪些例子能够区分理念是否落地？

每次讨论可先选一个问题、用具体场景确认，再更新对应文档；未达成一致的部分继续标为待讨论。

## 现有资料及其范围

- **已有愿景材料：** [Why an Agent Harness](../../concepts/agent-harness.md) 保留了早期 README 的发动机类比和 Agent 循环；其中的比喻与判断还需在本轮讨论中重新确认。
- **当前词汇与实现说明：** [核心概念](core-concepts.md)、[架构](architecture.md)和[参考文档](../reference/index.md)描述现有系统。它们不是一份已确认的长期理念清单；当前行为仍需结合代码与测试核对。
- **已接受的设计：** [Host / Agent / Capability / Toolkit 领域关系](../../design/host-agent-capability-toolkit.md)记录了已接受的装配约束，包括普通构造辅助不应成为平级领域角色。这是设计决策，不自动代表所有项目理念已经确定。
- **待 review 的工作设计：** [Root、Supervisor 与 Capability 的状态与交接](../../design/agent-runtime/run-scoped-supervisor-session.md)提出由模型决定如何完成任务、程序维护执行约束的方向；可作为分工讨论的输入，不视作本轮已确认结论。
- **历史材料：** [历史索引](../../history/index.md)保留早期设计、调查和迁移记录，用于理解背景，不覆盖当前契约。

## 已发现的文档勘误

这两项是当前系统描述需要修正的问题，和理念讨论分开处理：

- 架构图将 Studio 画在 Local Host 之下，但 [StudioHost](../../../packages/studio/src/host/StudioHost.ts) 有独立入口和生命周期，并复用 Host 装配能力。需要重新核对并更新中英文系统地图。
- 概念与架构页仍使用旧的 Toolkit Runtime 归属和生命周期表述；[当前 RS 契约](../../reference/extensions/toolkit-rs.md)说明旧 `AgentToolkit.runtime` / `ToolkitRuntimeManager` 已删除，Host 注入 RS 依赖。需要按当前代码整理这些描述，避免把一个 RS 简化为某个 Toolkit 私有的运行时。
