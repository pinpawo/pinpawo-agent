# 兼容与边界说明

> **Status: historical implementation.** The legacy Capability Artifact Pipeline is retired. See the current [Artifacts Toolkit](../../../reference/artifacts/index.md) and [Deliverables](../../../reference/deliverables.md) contracts.

## `additional_kwargs` 不是主协议

当前设计要求不要把持久化协议放进模型 prompt 或 `additional_kwargs`。

允许用它放置的只是**运行时元数据**，例如：

- lane/delegation/run 标识
- LangChain summarization 来源标记（`lc_source: summarization`）

它们只影响当前/当前 turn 的行为。

## `ToolMessage.artifact` 的边界

`ToolMessage.artifact` 不是 Durable 契约。

- 可用于单次工具事件里的临时附件（现阶段未作为跨 run 统一入口）。
- 跨 turn/跨 run 的可复用结果必须进入 `CapabilityArtifactStore` + `sessionCapabilityArtifacts`。

例外：`delegate_capability` 结果的 `ToolMessage.artifact` 是运行时自己写入的**执行记录**（`kind: executed | rejected`，含委派输入与结果），随 checkpoint 持久化，Supervisor 验收、上下文压缩和 Host 投影都通过 `readCapabilityExecutions` 读取它。它的兼容边界是 checkpoint 命名空间版本（`HOST_CHECKPOINT_CONTRACT`），不是 `CapabilityArtifactStore`；Capability 产物仍只进入 store。

## 关于 `runId` / `turnId`

- `CapabilityArtifactRef` 当前字段是 `runId`。
- 本地 store 读取旧 manifest/ref 时仍把 `turnId` 归一为 `runId`；它不是公共查询参数。
- 真正的 trace 以 `threadId + delegationId + runId + capabilityId + kind` 为主。

## 与旧字段的迁移原则

- 仍可在文档里看到旧有概念（如 `finalDispatchId`）时，新的标准是以 `CapabilityArtifactRef` 与 `sessionCapabilityArtifacts` 为准。
- `summary/head` 属于内容层描述，不是 ref 的固有字段。
- 若已有实现仍在解析历史 marker，请使用明确迁移计划，而不是并行保留多个源头。
- `contextPolicy` / `contextManagement` / `rewriteAsync` / `artifactSink` 已删除，不提供兼容别名。
