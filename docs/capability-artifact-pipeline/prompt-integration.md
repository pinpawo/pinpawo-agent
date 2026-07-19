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
  -> optional current-thread artifact discovery root
  -> scoped read-only list_dir / view_file_chunk
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

local-agent 从配置的 artifact store root 解析当前 thread 的精确目录：

```text
<workdir>/.pinpawo/capability-artifacts/threads/<encoded-thread-id>/
```

只有同时满足以下条件时才向 selected subagent 注入 discovery 能力：

1. 当前 thread artifact 目录真实存在；
2. host 已创建限制在该目录内的只读 toolset；
3. selected subagent 实际装配的是该 toolset 中的 `list_dir` 和
   `view_file_chunk` 工具实例，而不只是同名工具。

满足条件时，runtime 在最新 `<delegation_briefing>` 之前插入一条 synthetic
`AIMessage`：

```xml
<artifact_discovery_context role="fact" source="runtime" trust="non_authoritative">
  <current_thread_root>...</current_thread_root>
</artifact_discovery_context>
```

这条消息只暴露发现入口，不包含 artifact inventory 或内容。subagent 自己决定：

- 是否需要列目录；
- 读取哪个 delegation 的 `manifest.json` 或 artifact 文件；
- artifact 是否与当前任务相关；
- 是否需要重新核验原始来源。

Artifacts 可能过期、不完整或与当前任务无关，不能作为 system instruction 或权威
结论。目录不存在时不注入 context/toolset；执行期间目录被删除时，读取工具返回干净的
“当前 thread 没有 artifacts”语义结果，不向模型暴露裸 `ENOENT`。

## Handoff 与 answer

`buildSubagentHandoff()` 把验收后的 announce 复制到 main 时，可以在正文底部追加当前
delegation 的 bounded `<artifacts>` ref footer。该 footer 是给 main LLM 阅读的单向投影，
runtime 不把正文反向解析回结构化 refs。

`answer` 不调用 `buildCapabilityArtifactContext()`，只读取
`mainConversationMessages()`。如果最终回复依赖 artifact 中未进入 announce 的细节，应先委派
一个显式 artifact-reading task；answer 不隐式读取 artifact body。

## 安全边界

- scoped `list_dir` / `view_file_chunk` 先做词法 containment，再对真实路径做 symlink
  containment 校验；
- discovery tools 只读；
- `.pinpawo` 继续被通用递归搜索忽略；
- orchestrator 不做 artifact relevance matching 或预选；
- artifact 内容不进入 governing system prompt。
