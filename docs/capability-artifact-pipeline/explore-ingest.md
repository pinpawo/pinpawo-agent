# Explore 的两阶段持久化流程

## 目标

在不丢失关键结论的前提下，压缩旧的原始 tool output，同时保留长期可读能力。

## 数据结构

`ExploreKnowledgeIngest`：

- `summary: string`（Markdown）
- `evidence: { source, proves, value }[]`

`evidence` 被写进 artifact `metadata.evidence`，可用于复核。

## 两阶段触发

### 1) 旧输出压缩阶段（`rewriteOldToolOutput`）

- 条件：`ProviderUsageWatermarkGuard` 判定最近一次 provider `usage_metadata.input_tokens` 达到压缩水位，且存在可压缩的历史 tool 输出（最近 N 条保留原文）。
  - 水位：`latestProviderInputTokens >= floor((compressionBudgetTokens ?? contextWindowTokens) * compressionThresholdRatio)`。
  - `compressionBudgetTokens` 未配置时，默认使用当前 subagent 所用模型的 `contextWindowTokens`。
- 提取证据摘要。
- 调用 `ingestExploreKnowledge()` 产出 `summary + evidence`。
  - 成功后：
  - 在消息流里追加 `Explore summary:` 标记与摘要正文。
  - 用占位 marker 替换老的 tool output（保留最近 N 条）。
  - 暂存 `pendingArtifact`（仅本 run）
- 失败：不改变原始上下文（non-fatal）。

### 2) finalize 阶段（`afterRun`）

`SubagentResult` 收尾时，按优先级写 artifact：

1. `pendingArtifact`（旧输出压缩阶段已生成）
2. 从消息中读取已有 `Explore summary:` marker
3. `buildFinalExploreIngest()` 重算一次最终摘要

若得到 ingest 结果：

- 写入一条 `kind: 'report'`，`mimeType: 'text/markdown'`
- 写入 `metadata.evidence`
- 通过 `recordCapabilityArtifact` 回传

失败不阻断主流程（仅 warn）。

## 与 `additional_kwargs` 的关系

`additional_kwargs.pinpawo` 在 explore 内部只用于元信息标记：

- `exploreRawEvicted`（工具输出已摘要）
- `exploreIngestFailed`（可用于提前放弃历史读取）

它不是“跨 run 的摘要载体”。持久化内容仍走 `capability artifact`。

## 与 main agent 的关系

- summarize 结果最终变成可见 `preview` + ref 在 prompt。
- main agent 想访问完整内容需调用 store（当前主要由 host/工具层按需读取）。
