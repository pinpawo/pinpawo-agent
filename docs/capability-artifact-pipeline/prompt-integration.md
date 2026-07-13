# 主流程上下文注入（Prompt Binding）

## 发生位置

`sessionCapabilityArtifacts` 仍然注入到决策输入，但**任务归属优先在子任务 announce 上承载**。

目前注入路径是：

1. `taskDecision`（用户请求到单步 task）
2. `routeDecision`（task 到执行 lane）
3. `delegation_outcome`（委派结果决策）

注入函数主要是 `buildCapabilityArtifactContext()`（全局短引用）与 `buildSubagentAnnounceContext()`（任务级归属）。

## 注入的内容

当前在 prompt 中可见的字段：

- `kind`
- `title`（无则回退 `id`）
- `capability`
- `uri`
- `preview`（有则显示）

不会注入：

- 原始 `content`
- 二进制主体
- 完整 evidence 或 source list

## 当前的“归属”表达

能力 `sessionCapabilityArtifacts` 仍然保留 `capabilityId/delegationId/runId`，但更直接的任务归属现在放在子任务 announce 复制消息里。

`buildSubagentHandoff()` 会把当前委派的 announce 复制到主队列时，直接在正文底部追加一段 `<artifacts>` 预览块（`formatHandoffArtifactRefsForMessage`）。这段 footer 是**只写不读**：它作为主消息正文供 LLM 阅读，运行时代码不再把它解析回结构化 refs。

模型侧因此在 `delegation_outcome` 决策里，看到的是：

- `currentTaskContext`（当前委派上下文）
- `subagent_announce`（announce 全文 + artifact refs 的可读性短引用，来自 `state.taskActiveDelegation` 的结构化 refs）
- `otherTasksContext`（其它历史委派）

`buildRunDelegationContext` 仍作为补充上下文保留。已删除的全局 recent-announce 上下文（`readRecentAnnounces` / `buildPreparedRequestContext` 的 `recentAnnounces` 参数）不再存在：completed announce 通过 main handoff 进入主队列，由 `mainConversationMessages()` 覆盖；unfinished delegation 由 outcomeDecision 处理。

如果你希望在 `taskDecision` 里也只按任务归属展示 artifact，可在未来按 `capability_artifacts` 做 `delegationId` 分组重构。

## 注入链路（运行时）

```text
capabilityNode 执行完成
  ├─ state.sessionCapabilityArtifacts (refs)
  ├─ active delegation 结束时，buildSubagentHandoff 追加到 announce copy 的短引用文本（正文末尾）
  ├─ requestContext = buildPreparedRequestContext(...)
  ├─ buildCapabilityArtifactContext(state.sessionCapabilityArtifacts)
  ├─ handoff announce copy 已在主队列里（正文含 <artifacts> footer，供 LLM 阅读）
  ├─ system/decision input（XML-like block）
  └─ 模型仅使用 ref 层上下文决策
```

## 与主答复节点的关系

`answer` 节点不使用 `buildCapabilityArtifactContext`；它只读 `mainConversationMessages()`。
也就是它用的是主对话可见内容（announce + 用户消息 + 历史对话）。
