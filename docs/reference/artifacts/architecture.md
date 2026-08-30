# 架构概览：Capability V2 Artifact 流程

> 状态：Current
> 更新：2026-07-27

当前实现把 Capability 的可持久化产出分成 **artifact ref** 与 **store
content** 两层。Capability / Toolkit 的公共边界见
[Capability / Toolkit V2 契约](../extensions/capability-toolkit.md)。

## 一句话流程

```text
Capability subagent 运行
  -> SubagentResult
  -> Capability.lifecycle.finalize(result, context)
       ├─ CapabilityArtifactStore.writeArtifact(...)
       ├─ context.recordCapabilityArtifact(ref)
       └─ 或返回 artifactRefs
  -> capability node 合并 SubagentResult.artifacts
  -> state.sessionCapabilityArtifacts
  -> accepted announce handoff 附带当前 delegation 的 bounded refs
```

Artifact payload 不进入 LangGraph state。需要完整内容时，消费者通过
`CapabilityArtifactStore.readArtifact(uri)` 回读。

## 组件职责

### pet-agent core

- `CapabilityArtifactStore` 只定义持久化 port，不依赖具体文件系统 adapter。
- capability node 在执行后调用可选的 `lifecycle.finalize`。
- finalize context 提供稳定的 `threadId / capabilityId / delegationId / runId`、
  artifact store 和 ref recorder。
- `sessionCapabilityArtifacts` 只保存 refs，并跨 turn 保留。
- 当前 task 的 outcome context 可以读取当前 delegation 的 bounded refs；
  entryDecision 不接收 session-wide artifact inventory。

### Capability

- Capability instructions 负责业务目标和交付要求。
- 需要确定性持久化时，Capability 的可选代码入口只导出
  `lifecycle.finalize`。
- finalize 基于已经产生的 `SubagentResult` 整理 announce 或写入 artifact；
  它不是第二个 agent loop，也不拥有额外工具权限。
- 需要执行外部动作的代码必须作为 Toolkit tool 暴露，并由 Capability 的
  `uses` 授权。

### Host store

`services/local-agent/src/capabilityArtifactStore.ts` 实现本地持久化：

- 写入内容并返回稳定 `CapabilityArtifactRef`；
- 按 thread scope 解析 `capability-artifact://` URI；
- 提供 list/read/download 等 host 能力；
- 不把绝对文件系统路径暴露给模型。

## 历史 Artifact 发现

历史 artifact 读取不是 Capability 的隐式能力。local-agent 按当前 thread 创建
`artifact_discovery` Toolkit：

```text
artifact_discovery
  ├─ artifact_list -> store.listArtifacts(threadId)
  └─ artifact_read -> store.readArtifact(threadId, uri)
```

需要历史产物的 Capability 必须静态声明：

```yaml
uses:
  - artifact_discovery
```

编译成功后，framework 在 Capability 的执行 prompt section 中说明上述工具
可用。它不会生成 synthetic history message，也不会把 artifact inventory 或
内容直接塞进模型上下文。

空 thread 的 list 结果为空；这不是 Toolkit 不可用。local chat host 要求非空
`threadId` 和 `CapabilityArtifactStore`，避免 scope 缺失导致依赖该 Toolkit 的
Capability 静默消失。

## 状态与消息边界

- `SubagentResult.artifacts`：本次 subagent 运行返回的 refs。
- `sessionCapabilityArtifacts`：orchestrator session 中跨 turn 的 ref 索引。
- announce：给 orchestrator 和用户读取的自然语言交付。
- handoff：验收后的 announce 主队列副本，可附带当前 delegation 的 bounded
  artifact refs。
- store content：长报告、结构化数据、图片、视频或其他不应进入 message/state
  的 payload。

Artifact 不替代 announce，announce 也不替代 durable content。前者提供稳定寻址，
后者提供当前任务可以判断和交接的自然语言结果。

## 不再存在的 V1 路径

- `capability.createRuntime()`
- `CapabilityContext.availableToolkits`
- `capability.middleware.afterRun`
- `resultSchema`
- 模型通过 marker 或 `additional_kwargs` 注册 artifact
- orchestrator 默认读取 artifact 全文

历史设计文档可以保留这些名称解释演进，但它们不是当前 API。
