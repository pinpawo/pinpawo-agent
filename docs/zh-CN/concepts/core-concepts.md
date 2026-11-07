# 核心概念

[English](../../concepts/core-concepts.md)

PinPawo Agent 以 `pet-agent` 已实现的可靠单 Agent 机制为基础组织 Studio。Studio Plugin 实现业务上的可插拔；Capability 与 Toolkit 让 Agent 的能力可组织、可扩展。

运行时已有工具权限、审核、checkpoint 和恢复等机制。项目在这些基础上结合真实工作持续迭代，进一步提升可靠程度。尚待对齐的问题见[核心理念讨论](principles-discussion.md)。

<a id="项目带来的价值"></a>

## 各部分如何配合

- **Pet agent** 是单 Agent 运行单元，处理请求，并在配置的权限范围内使用 Capability 和 Toolkit。
- **Studio** 组织多个 Pet runtime 的工作。Plugin 为业务行为提供扩展点，也有一些 Plugin 提供基础设施。
- **Capability 与 Toolkit** 组织 Agent 的能力。Capability 描述专门工作并声明所使用的 Toolkit；Toolkit 提供工具和相应策略。Plugin 可以提供 Toolkit，Host 则为各 Pet 独立选择 Capability。

当前包和运行时边界见[架构](architecture.md)。

## 术语

| 术语 | 含义 | 作用 |
|---|---|---|
| **Host** | 解析配置、选择 Capability/Toolkit definitions、持有 Agent runtime 并提供执行环境依赖的产品或进程边界。 | 把机器、transport 与生命周期职责留在 Agent graph 之外。 |
| **Pet agent** | 具有模型、Capability、编译后 Toolkit binding 与状态的一套 Agent runtime。 | 接收 invocation 并产生面向用户的结果。 |
| **Capability** | 带有任务说明和固定 Toolkit allowlist 的可委派工作单元。 | 让路由和工具权限可检查。 |
| **Toolkit** | 一组 typed 工具、说明、可用性检查、审核指导及可选执行环境依赖。 | 组织可复用的工具实现与策略。 |
| **Subagent lane** | 一次 Capability 或通用任务使用的短生命周期私有执行上下文。 | 隔离任务推理，避免污染主对话。 |
| **Human review** | 需要用户授权或补充输入时的暂停与继续边界。 | 审批是运行时契约，而不是提示词约定。 |
| **Checkpoint** | 配置 checkpointer 时，LangGraph 为消息与待继续执行保存的状态。 | 支持继续执行与恢复。 |
| **Session projection** | checkpoint 与当前运行事实的客户端无关表示。 | 客户端不需要各自重建状态。 |
| **Studio** | 多 Pet 的 dispatch 底座：Pet registry、只读的每 Pet dispatch-admission 队列观测与 Plugin 事件总线。 | 组织多个 Pet runtime 的工作。 |
| **Studio Plugin** | 可以派发工作、交换事件、持有领域状态并可提供 Toolkit 的 Studio 扩展。 | 通过 Plugin 增加业务行为。 |
| **Workdir** | 运行时配置、Studio 状态和相对工具路径的本地作用域。 | 防止不同项目误共享状态。 |

<a id="两个扩展边界"></a>

## Capability 与 Toolkit 的扩展边界

```text
用户请求 → Pet agent → Capability（意图 + Toolkit allowlist）
                     → Toolkit（typed 工具 + 审核策略）
```

Capability 描述“完成什么任务”；Toolkit 提供工具或共享说明，以及相应策略。Capability 的说明可以用 Markdown 或代码编写，可执行工具及其策略定义在 typed Toolkit 中。

旧 Capability Artifact Pipeline 和 Channel 消息附件字段已退役；见[退役说明](../../reference/extensions/capability-toolkit.md#7-旧-artifact-pipeline-退役)与当前[消息 API](../../reference/api/studio.md#channel-messages-and-addressing)。[artifacts Toolkit](../../../toolkits/artifacts/README.md) 已实现文件快照发布、当前 session 产物列表和共享 `artifact://` 引用的下载。[Session Artifacts 设计](../../design/agent-runtime/session-artifacts.md)说明交付链路，其中未决问题仍属提案。

Host 创建并持有 Agent runtime，为 Toolkit 声明的执行环境依赖提供实例；多个 Toolkit 可以共享同一环境依赖。详见 [Toolkit RS 契约](../../reference/extensions/toolkit-rs.md)和已接受的[领域关系设计](../../design/host-agent-capability-toolkit.md)。

## 概念的唯一详细入口

| 概念范围 | 当前详细契约 |
|---|---|
| Capability 与 Toolkit 权限 | [扩展契约](../reference/extensions/capability-toolkit.md) |
| Toolkit 执行环境依赖 | [Toolkit RS 契约](../../reference/extensions/toolkit-rs.md) |
| 审核与授权复用 | [事件与人工审核（英文）](../../reference/api/events-and-review.md) 与 [授权匹配器（英文）](../../reference/runtime/authorization-matcher.md) |
| checkpoint、session、snapshot 与 timeline | [Session projection（英文）](../../reference/runtime/session-projection.md) |
| 旧 artifact 扩展更新 | [退役说明](../../reference/extensions/capability-toolkit.md#7-旧-artifact-pipeline-退役) |
| workdir 与运行时配置 | [Workdir 配置](../reference/runtime/workdir.md) |
| 多 Agent 协调 | [Studio](../studio/index.md) |

## 执行模型

一次用户请求不会自动获得全部工具权限。运行时可以直接回答；需要委派时，选择通用任务或 Capability，在隔离 lane 中执行，按照 Toolkit policy 继续、审核或阻止，并把执行结果交回主对话。

主对话接收完成结果，而不是完整私有 scratchpad 与工具过程，因此既能控制上下文增长，也能让最终答案基于真实完成的工作。
