# 兼容与边界说明

## `additional_kwargs` 不是主协议

当前设计要求不要把持久化协议放进模型 prompt 或 `additional_kwargs`。

允许用它放置的只是**运行时元数据**，例如：

- lane/delegation/run 标识
- context-policy 压缩 marker（`contextPolicyRewrite`）
- explore 的重试/压缩标记（`exploreRawEvicted` / `exploreIngestFailed`）

它们只影响当前/当前 turn 的行为。

## `ToolMessage.artifact` 的边界

`ToolMessage.artifact` 不是 Durable 契约。

- 可用于单次工具事件里的临时附件（现阶段未作为跨 run 统一入口）。
- 跨 turn/跨 run 的可复用结果必须进入 `CapabilityArtifactStore` + `sessionCapabilityArtifacts`。

## 关于 `runId` / `turnId`

- `CapabilityArtifactRef` 当前字段是 `runId`。
- 选择器里有兼容字段 `turnId`，仅用于旧调用兼容。
- 真正的 trace 以 `threadId + delegationId + runId + capabilityId + kind` 为主。

## 与旧字段的迁移原则

- 仍可在文档里看到旧有概念（如 `finalDispatchId`）时，新的标准是以 `CapabilityArtifactRef` 与 `sessionCapabilityArtifacts` 为准。
- `summary/head` 属于内容层描述，不是 ref 的固有字段。
- 若已有实现仍在解析历史 marker，请使用明确迁移计划，而不是并行保留多个源头。

