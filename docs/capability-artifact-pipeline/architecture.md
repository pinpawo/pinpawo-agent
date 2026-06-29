# 架构概览：新流程

当前实现把 `capability` 的可持久化产出定义为 **artifact ref + store 内容** 两层。

## 一句话流程

```text
subagent / capability 运行
  ├─ capabilityRuntime 持有 `artifactStore`（持久化写入接口）
  ├─ 在代码侧（context rewrite/afterRun）产出 ArtifactRef
  ├─ 通过 `recordCapabilityArtifact` 落到 `SubagentResult.artifacts`
  ├─ `capabilityNode` 合并到 `state.sessionCapabilityArtifacts`
  ├─ 委派结束时，`buildSubagentHandoff` 将当前 announce 复制到主队列
  └─ 主队列 announce copy 在正文末尾追加该委派的 `artifact refs` 预览

决策节点默认继续使用短引用（<run> / <lane> / <artifact uri> / preview），但任务级归属信息优先通过：

- `currentTaskContext`
- `subagent_announce`（含当前任务 `artifact refs`）

这样主编排可以不依赖系统提示里持久枚举全部 artifact 全量语义。

能力需要完整内容时：`state` 不持有内容，只能通过 `CapabilityArtifactStore.readArtifact` 按 uri 回读。
```

## 组件职责

- **pet-agent 编排层（packages/pet-agent）**
  - 不关心产物内部字节。
  - 注入 `artifactStore`，并在执行时提供 `recordCapabilityArtifact`。
  - 维护 `sessionCapabilityArtifacts`（跨 turn 不清空）。
  - 决策节点只注入简短 `ref` 到系统 prompt。

- **能力侧（packages/local-agent/src/capabilities/*）**
  - 自己决定何时写入 artifact（通常 in-loop ingest 或 `afterRun`）。
  - 负责构造 `kind/mimeType/title/preview` 等元信息。
  - 通过 `artifactSink.recordCapabilityArtifact` 回传 ref。

- **store 实现（services/local-agent/src/capabilityArtifactStore.ts）**
  - 实现 `CapabilityArtifactStore`。
  - 落盘内容并返回稳定 `CapabilityArtifactRef`。
  - 解析 `capability-artifact://` URI 与 `readArtifact/getDownloadUri`。

## 关键状态与链路

1. `capability.createRuntime()` 时注入 `CapabilityContext.artifactStore`。
2. `createSubagent()` 运行上下文收到 `artifactSink`（`threadId/delegationId/runId`）。
3. 子代理上下文改写 hook（如 explore）可在中间过程记录 `pending` 摘要。
4. `capability.middleware.afterRun` 将最终 `Pending`/`final` 摘要写入 store。
5. Subagent graph state 的 `artifacts` 与 `artifactSink` 汇总的 refs 回传。
6. `capabilityNode` 在 `sessionCapabilityArtifacts` 上使用 reducer 合并。

## 与旧路径的关系

- 不再依赖模型内的 `additional_kwargs` 来传递 artifact 注册信息。
- `ToolMessage.artifact` 不是全局可复用协议；不会替代 store 引用。
- `main agent` 也不会在 prompt 中看到完整 artifact 内容，只看摘要级元信息。
