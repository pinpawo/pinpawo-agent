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

`buildSubagentHandoff()` 会把当前委派的 announce 复制到主队列时，直接在正文底部追加一段 `<artifacts>` 预览块；`readRecentAnnounces` 不再从 `additional_kwargs` 重建引用来源，而是读取主队列主消息正文并保留该内容。

模型侧因此在 `delegation_outcome` 决策里，看到的是：

- `currentTaskContext`（当前委派上下文）
- `subagent_announce`（announce 全文 + artifact refs 的可读性短引用）
- `otherTasksContext`（其它历史委派）

`buildRunDelegationContext` 和 `recentSubagentAnnounces` 仍作为补充上下文保留。

如果你希望在 `taskDecision` 里也只按任务归属展示 artifact，可在未来按 `capability_artifacts` 做 `delegationId` 分组重构。

## 注入链路（运行时）

```text
capabilityNode 执行完成
  ├─ state.sessionCapabilityArtifacts (refs)
  ├─ active delegation 结束时，buildSubagentHandoff 追加到 announce copy 的短引用文本（正文末尾）
  ├─ requestContext = buildPreparedRequestContext(...)
  ├─ buildCapabilityArtifactContext(state.sessionCapabilityArtifacts)
  ├─ readRecentAnnounces(...) 恢复 handoff announce（含 artifact refs）
  ├─ system/decision input（XML-like block）
  └─ 模型仅使用 ref 层上下文决策
```

## 与主答复节点的关系

`answer` 节点不使用 `buildCapabilityArtifactContext`；它只读 `mainConversationMessages()`。
也就是它用的是主对话可见内容（announce + 用户消息 + 历史对话）。
