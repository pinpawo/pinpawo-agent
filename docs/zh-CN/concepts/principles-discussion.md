# 项目核心理念：讨论起点

> **状态：持续对齐。** 本页区分项目维护者已明确的方向和待讨论问题，不修改现有运行契约。

## 为什么回看

此前文档把项目目标、已接受的设计和具体实现放得较近。本次先调整 [README](../../../README.md)、[核心概念](core-concepts.md)和[架构](architecture.md)，让读者能够区分项目目标与当前设计；仅凭代码已经这样实现，不能证明它是长期理念或目标已达成。

## 已明确的项目目标

项目维护者对项目目标的原话：

> 嗯，我们整个项目的目标，是基于一套 可靠的 单agent的 机制（pet-agent），然后。来组织一套 studio。中间通过studio plugin来实现业务上的可插拔，通过capability+toolkit 实现能力上的可组织可扩展。

据此，讨论时先区分这几个层次和作用：

- **基础：pet-agent** 以可靠的单 Agent 机制为目标。
- **组织：Studio** 基于这套单 Agent 机制来组织工作。
- **业务扩展：Studio Plugin** 实现业务上的可插拔。
- **能力扩展：Capability + Toolkit** 让能力可组织、可扩展。

这是对上述目标的整理，不规定具体组件如何实现、部署或相互调用，也不意味着“可靠”的验收标准已确定或目标已经达成。审核、恢复等是持续迭代的设计机制，不等同于可靠性目标本身。

## 本轮文档调整

[文档首页](../index.md)与[核心概念](core-concepts.md)以项目目标说明单 Agent 基础、Studio 和两个扩展维度；[架构](architecture.md)描述当前实现和边界。Studio 的[当前契约](../studio/index.md)仍侧重 dispatch、事件和所有权，不应单独作为整个项目目标的定义。

[领域关系设计](../../design/host-agent-capability-toolkit.md)讨论 Host、Agent、Capability、Toolkit 的装配约束；它不是对 Studio 和 Studio Plugin 项目作用的完整概括。设计是否支持目标，需要结合具体场景持续检验。

## 建议逐项讨论

1. **怎样定义可靠的单 Agent？** 选择哪些真实任务、失败和恢复场景，才能判断 pet-agent 机制是否可靠？
2. **Studio 要组织什么业务工作？** 项目主要服务谁，期望达成什么结果？Studio Plugin 的业务可插拔如何从具体例子中体现？
3. **能力如何组织和扩展？** Capability 与 Toolkit 如何共同支持能力复用？它们与业务插件如何配合，边界有哪些待明确的情况？
4. **模型和程序如何分工？** 哪些判断应留给模型结合上下文处理，哪些权限、协议或恢复边界需要程序保障？遇到不确定或失败时，Agent 应如何推进、何时停下来？
5. **哪些属于理念，如何验收？** 哪些概念长期有用，哪些只是可替换的实现？对结果、过程透明度和用户控制分别有什么期望？普通 helper 应在什么情况下进入公共概念？

每次讨论可先选一个问题、用具体场景确认，再更新对应文档；未达成一致的部分继续标为待讨论。

## 现有资料及其范围

- **已有愿景材料：** [Why an Agent Harness](../../concepts/agent-harness.md) 保留了早期 README 的发动机类比和 Agent 循环；其中的比喻与判断还需在本轮讨论中重新确认。
- **当前词汇与实现说明：** [核心概念](core-concepts.md)、[架构](architecture.md)和[参考文档](../reference/index.md)描述现有系统。它们不是一份已确认的长期理念清单；当前行为仍需结合代码与测试核对。
- **已接受的设计：** [Host / Agent / Capability / Toolkit 领域关系](../../design/host-agent-capability-toolkit.md)记录了已接受的装配约束，包括普通构造辅助不应成为平级领域角色。这是设计决策，不自动代表所有项目理念已经确定。
- **待 review 的工作设计：** [Root、Supervisor 与 Capability 的状态与交接](../../design/agent-runtime/run-scoped-supervisor-session.md)提出由模型决定如何完成任务、程序维护执行约束的方向；可作为分工讨论的输入，不视作本轮已确认结论。
- **历史材料：** [历史索引](../../history/index.md)保留早期设计、调查和迁移记录，用于理解背景，不覆盖当前契约。

## 已修正的文档问题

中英文架构图已区分 Studio Host 和 Chat Host 的独立入口；概念与架构页中的旧 Toolkit Runtime 表述已按 [RS 契约](../../reference/extensions/toolkit-rs.md)更新。现行实现和边界仍以代码与相应参考文档为准。
