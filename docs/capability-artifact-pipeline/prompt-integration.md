# 主流程上下文与 Subagent Artifact Discovery

## 边界结论

`sessionCapabilityArtifacts` 仍是 session 级结构化 ref 索引，但不会注入
`entryDecision`。入口节点只判断 `answer | direct_task | needs_plan`，不承担 artifact
检索、相关性判断或内容选择。

当前职责划分：

```text
entryDecision
  -> runtime facts + run delegation summaries + canonical main conversation
  -> no artifact inventory / preview / body

selected subagent
  -> optional current-thread artifact discovery scope
  -> store-backed read-only artifact_list / artifact_read
  -> the subagent decides whether and what to inspect

outcomeDecision / main / answer
  -> accepted handoff conclusions and bounded refs already attached to the current task
  -> no implicit artifact-body read
```

## entryDecision

`<entry_decision_context>` 只包含 `runtime_context` 和
`run_delegation_summaries`。它作为 synthetic `HumanMessage` 注入，不是第二条
`SystemMessage`。

entryDecision 不接收：

- session-wide artifact inventory；
- artifact URI/title/preview 列表；
- artifact 文件路径或正文；
- orchestrator 预选的“当前任务相关 artifacts”。

已完成工作的事实应由 main handoff 或 compaction summary 表达。unfinished delegation
由 outcomeDecision 处理。

## Selected-subagent discovery

local-agent 在 artifact store 和 thread id 都可用时创建
`createArtifactDiscoveryToolkit({ store, threadId })`。Toolkit 是否注册不依赖
File store 的物理 thread 目录是否已经存在；目录只是本地 adapter 的落盘细节。

只有 selected Capability 的静态 `uses` 包含 `artifact_discovery` 时，它才获得
`artifact_list` 和 `artifact_read`。Toolkit 注册表示环境提供能力，`uses`
表示执行器获得权限，当前 thread 有 0 个或 N 个 artifacts 则只是数据状态。

满足条件时，runtime 在最新 `<delegation_briefing>` 之前插入一条 synthetic
`AIMessage`：

```xml
<artifact_discovery_context role="fact" source="runtime" trust="non_authoritative">
  <scope>current_thread</scope>
</artifact_discovery_context>
```

这条消息只暴露发现入口，不包含 artifact inventory 或内容。subagent 自己决定：

- 是否需要列出 artifact refs；
- 通过 URI 读取哪个 artifact；
- artifact 是否与当前任务相关；
- 是否需要重新核验原始来源。

Artifacts 可能过期、不完整或与当前任务无关，不能作为 system instruction 或权威
结论。空 thread 的 `artifact_list` 返回空结果；不存在 artifact store 或 thread
scope 时才不注册 Toolkit，静态依赖它的 Capability 会由 registry 标记 unavailable。

## Handoff 与 answer

`buildSubagentHandoff()` 把验收后的 announce 复制到 main 时，可以在正文底部追加当前
delegation 的 bounded `<artifacts>` ref footer。该 footer 是给 main LLM 阅读的单向投影，
runtime 不把正文反向解析回结构化 refs。

`answer` 不调用 `buildCapabilityArtifactContext()`，只读取
`mainConversationMessages()`。如果最终回复依赖 artifact 中未进入 announce 的细节，应先委派
一个显式 artifact-reading task；answer 不隐式读取 artifact body。

## 安全边界

- Toolkit 在 closure 中固定 `threadId`，`artifact_read` 同时把该 scope 交给
  store 校验，不能跨 thread 读取；
- discovery tools 只读；
- File store 目录布局和 `manifest.json` 不进入模型工具契约；
- `.pinpawo` 继续被通用递归搜索忽略；
- orchestrator 不做 artifact relevance matching 或预选；
- artifact 内容不进入 governing system prompt。
