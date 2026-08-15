# 核心概念

> **状态：当前概念指南。** 本页定义稳定术语；具体实现和类型契约由所链接的 Reference 页面维护。

[English](../../concepts/core-concepts.md)

PinPawo Agent 是一个本地优先的 Agent 框架。它让模型可以推理、使用工具、请求审批和委派专门工作，同时把权限、状态和执行边界保持为可检查的系统结构，而不是隐藏在一段大提示词里。

## 项目带来的价值

- **本地控制：** host、工具、session 和可选浏览器桥接都在操作者选择的机器上运行；模型提供商和端点由你决定。
- **显式权限：** Capability 必须声明可使用的 Toolkit；有副作用的工具可在执行前等待人工审核。
- **可恢复执行：** checkpoint 保存对话和待继续状态，session projection 为 TUI 与集成提供统一视图。
- **可组合扩展：** 任务意图写在可审查的 Markdown Capability 中，可执行行为与安全策略写在 typed Toolkit 中。
- **可扩展协作：** Studio 提供多 Pet 的 dispatch、每 Pet 队列、runtime gate 与插件事件总线，而不暴露 worker 的私有推理。

## 术语

| 术语 | 含义 | 作用 |
|---|---|---|
| **Host** | 解析配置、选择 Capability/Toolkit definitions、持有 Agent runtime 并管理 Toolkit Runtime 生命周期的产品或进程边界。 | 把机器、transport 与生命周期职责留在 Agent graph 之外。 |
| **Pet agent** | 具有身份、模型、Capability、编译后 Toolkit binding 与状态的一套 Agent runtime。 | 接收 invocation 并产生面向用户的结果。 |
| **Capability** | 带有任务说明和固定 Toolkit allowlist 的可委派工作单元。 | 让路由和工具权限可检查。 |
| **Toolkit** | 一组 typed 工具、操作元数据、可用性检查、审核策略和可选 Toolkit Runtime。 | 集中管理可复用实现、安全规则与动态资源所有权。 |
| **Subagent lane** | 一次 Capability 或通用任务使用的短生命周期私有执行上下文。 | 隔离任务推理，避免污染主对话。 |
| **Human review** | 需要用户授权或补充输入时的暂停与继续边界。 | 审批是运行时契约，而不是提示词约定。 |
| **Checkpoint** | LangGraph 的持久状态，保存消息与待继续执行。 | resume 与恢复的权威来源。 |
| **Session projection** | checkpoint 与当前运行事实的客户端无关表示。 | 客户端不需要各自重建状态。 |
| **Artifact** | 要跨越 lane 或在清理后继续存在的结果引用。 | 避免把聊天消息当作长期存储。 |
| **Studio** | 多 Pet 的 dispatch 底座、每 Pet 队列、runtime gate 与插件事件总线。 | 在不破坏 worker 边界的前提下协作。 |
| **Workdir** | 运行时配置、Studio 状态和相对工具路径的本地作用域。 | 防止不同项目误共享状态。 |

## 三个扩展边界

```text
用户请求 → Pet agent → Capability（意图 + Toolkit allowlist）
                         → Toolkit（typed 工具 + 审核策略）
                         → Artifact（需要长期或跨边界保存时）
```

Capability 描述“完成什么任务”；Toolkit 描述“哪些行为可以执行、如何审核”；Artifact 只承担持久结果。这样 Markdown 保持易审查，而副作用留在 typed code。

Host 与 Agent 是所有权边界，不是新的扩展格式：Host 创建并持有一个或多个 Agent runtime；Agent 执行 Capability；Capability 通过 `uses` 引用 Toolkit；Toolkit Runtime 始终从属于 Toolkit。跨 Host 的 accepted constraints 见[领域关系设计（中文）](../../design/host-agent-capability-toolkit.md)。

## 概念的唯一详细入口

| 概念范围 | 当前详细契约 |
|---|---|
| Capability 与 Toolkit 权限 | [扩展契约](../reference/extensions/capability-toolkit.md) |
| 审核与授权复用 | [事件与人工审核（英文）](../../reference/api/events-and-review.md) 与 [授权匹配器（英文）](../../reference/runtime/authorization-matcher.md) |
| checkpoint、session、snapshot 与 timeline | [Session projection（英文）](../../reference/runtime/session-projection.md) |
| 跨 lane 的持久结果 | [Artifact Pipeline（英文）](../../reference/artifacts/index.md) |
| workdir 与运行时配置 | [Workdir 配置](../reference/runtime/workdir.md) |
| 多 Agent 协调 | [Studio](../studio/index.md) |

## 执行模型

一次用户请求不会自动获得全部工具权限。运行时通常依次：选择直接回答、通用任务或 Capability；在隔离 lane 中执行；按照 Toolkit policy 继续、审核或阻止；把完成结果交回主对话；只有需要长期保存时才写 Artifact。

主对话接收完成结果，而不是完整私有 scratchpad 与工具过程，因此既能控制上下文增长，也能让最终答案基于真实完成的工作。
