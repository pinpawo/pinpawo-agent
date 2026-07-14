# Explore 的摘要与 Artifact 流程

## 职责分离

- subagent 窗口维护：`createSubagent()` 根据 `contextWindowTokens` 自动安装 LangChain
  `summarizationMiddleware`。
- Explore 知识交付：`capability.middleware.afterRun` 生成结构化 `summary + evidence` 并写 store。

Explore 不再实现 `rewriteOldToolOutput`、`pendingArtifact` 或 in-loop artifact sink。

## Subagent 摘要阶段

达到 runtime 根据窗口派生的 token trigger 后，LangChain middleware：

1. 使用 subagent model 总结较早消息。
2. 保留任务目标、进展、关键发现、错误、待办及精确来源。
3. 使用 `RemoveMessage` 持久化替换旧消息。
4. 给摘要消息标记 `additional_kwargs.lc_source = 'summarization'`。
5. 保留近期消息原文供后续执行。

该阶段不写 artifact，也不按工具配置 keep/evict/truncate。

## Explore Finalize 阶段

`afterRun` 收集：

- 最新 LangChain context summary；
- 当前 transcript 中的 tool results（达到 evidence 预算时优先保留最新结果）；
- 最终 assistant 输出；
- 续跑上下文中已有的 `Explore summary:`。

然后调用 `ingestExploreKnowledge()` 生成：

- `summary: string`
- `evidence: { source, proves, value }[]`

成功后：

- ingest 生成新版 summary 时，在返回 messages 末尾追加新的 `Explore summary:`；
- 写一条 `kind: 'report'`、`mimeType: 'text/markdown'` artifact；
- 把 evidence 写入 `metadata.evidence`；
- 通过 `CapabilityMiddlewareContext.recordCapabilityArtifact` 回传 ref。

每次 capability run 最多执行一次 finalize artifact 写入。store 写入失败只记录 warning，
不改变 subagent completion。

## 与 main agent 的关系

main agent 只接收 artifact ref/title/preview 和最终 announce。完整报告保存在
`CapabilityArtifactStore`，不会重新注入主线 messages。
