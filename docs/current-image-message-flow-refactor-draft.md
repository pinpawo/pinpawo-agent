# OpenTUI v2 图片消息链路与最小重构（Draft）

> Status: Draft
>
> 本文分析 OpenTUI v2 chat 中用户图片从附件进入模型的实际链路，并定义一组有限的修复与验证工作。
> 范围仅覆盖现有图片输入、上下文压缩和 tracing；当前实现和测试仍是运行行为的权威来源。

## 1. 目标

本轮工作的目标是：

- 说明图片当前保存在哪里、经过哪些节点、在哪些位置被重复处理；
- 消除无效 payload 放大，同时保持现有有损压缩语义；
- 保持现有主消息和 subagent 上下文语义；
- 用调用数据判断后续是否还需要更深的媒体抽象。

核心原则：

> **压缩前保留模型完成当前步骤所需的图片；图片进入既有压缩区间后，遵循摘要替换旧消息的语义。**

## 2. 当前链路

### 2.1 从 OpenTUI v2 到主消息

本文中的 TUI 专指 [`@pinpawo/tui`](../services/tui/README.md)，源码位于 `services/tui/`，通过
`pinpawo tui` 或 `npm run tui -w pinpawo` 启动。

`services/local-agent` 提供 CLI launcher、认证 WebSocket host 和 agent runtime；仓库只保留这一套
终端客户端。

```text
OpenTUI v2 选择或粘贴本地图片路径
  -> AgentLocalAttachment(local path)
  -> LocalImageAttachmentAdmission
       - 检查模型是否支持 image
       - 检查 MIME、数量和大小
       - 读取 bytes，计算 sha256
       - 生成 base64 payload
  -> createAdmittedLocalChatHumanMessage
       - HumanMessage.content: text + image(mimeType, data)
       - additional_kwargs.pinpawo: display metadata + localImageReferences
  -> OrchestratorState.messages
  -> FileSaver checkpoint
```

对应实现：

- [`ingestLocalPathPaste`](../services/tui/src/attachments/localPathIngestion.ts)
- [`AgentLocalAttachment`](../packages/agent-session/src/localAttachments.ts)
- [`LocalImageAttachmentAdmission`](../services/local-agent/src/localImageAttachments.ts)
- [`createAdmittedLocalChatHumanMessage`](../services/local-agent/src/localChatAttachments.ts)
- [`OrchestratorState`](../packages/pet-agent/src/agent/orchestrator/state.ts)
- [`FileSaver`](../services/local-agent/src/fileSaver.ts)

当前图片的 canonical representation 是 `HumanMessage.content` 中的 LangChain 标准 `image` block。
会话所需的图片能力通过 `message.contentBlocks` 从 checkpoint messages 中读取，不依赖额外的 session
ledger。provider adapter 负责在模型边界转换成对应的原生图片格式。

### 2.2 各模型节点获得的图片上下文

| 模型调用 | 输入来源 | 当前是否包含主消息图片 |
|---|---|---|
| Entry Answer | system message + 完整 main human/AI messages | 是 |
| Capability Planner entry | Planner lane + 完整 main conversation + structured input | 是 |
| Capability subagent | 未分 lane 的主消息 + 当前 delegation 的实际执行记录 + 临时增强的 delegation briefing | 是 |
| Boundary Planner | Entry 相同的 main conversation + 当前 announce + structured boundary input | 是 |
| Current terminal finalizer | `<answer_input>` structured text only | 否 |
| Root compaction summarizer | 较旧 main messages 的文本投影 | 不读取图片内容 |
| Subagent summarizer | child messages，经 LangChain `getBufferString` 形成文本 | 图片表示为 `[image]`，不包含 data URL |

主要实现位置：

- Entry Answer：[`entryAnswer.ts`](../packages/pet-agent/src/agent/orchestrator/runtime/nodes/entryAnswer.ts)
- Planner input：[`capabilityPlanner.ts`](../packages/pet-agent/src/agent/orchestrator/runtime/nodes/capabilityPlanner.ts)
- Capability input：[`capability.ts`](../packages/pet-agent/src/agent/orchestrator/runtime/nodes/capability.ts)
- 当前终态收口：[`answer.ts`](../packages/pet-agent/src/agent/orchestrator/runtime/nodes/answer.ts)
- Message lane：[`messageLanes.ts`](../packages/pet-agent/src/agent/orchestrator/messageLanes.ts)

Planner 现在复用与 Entry 相同的 canonical main conversation，因此其中的标准图片 block
会到达 Planner 模型边界。Entry Answer、Planner 和 Capability 都可能理解图片；当前终态
收口只接收结构化文本投影。

### 2.3 Subagent 工具循环

`laneMessages` 会把未分 lane 的主消息和当前 delegation transcript 一起交给 Capability subagent。
因此用户图片会进入 subagent 的初始 messages，并随 createAgent 的后续模型循环继续存在，直到
child summarization 改写其内部消息列表或本次 subagent 结束。

同一图片出现在多次模型调用中是当前上下文语义的自然结果。provider prompt cache 可以减少其中
一部分计算和计费，但不会消除本地序列化、请求体传输和 tracing 处理。

### 2.4 Tracing

[`LocalAgentGraphService.streamEvents`](../services/local-agent/src/agentGraphService.ts) 在 root graph
run 上安装 [`CallbackHandler`](../services/local-agent/src/langfuseTracing.ts)。当前 callback 没有
PinPawo 侧的 message/media 投影，模型输入中的完整图片 payload 会进入 SDK 的媒体处理路径。

Tracing 与模型调用共享相同的 runnable callback tree，因此 Entry Answer、Planner 和 Capability
等实际包含图片的模型输入都可能触发 SDK 媒体处理。

## 3. 已确认的现状与问题

### 3.1 同一图片 payload 曾在一条消息中保存两次

`createAdmittedLocalChatHumanMessage` 当前同时写入：

```text
HumanMessage.content[].data
additional_kwargs.pinpawo.localImageReferences[].uri（旧实现）
```

仓库内没有 `localImageReferences[].uri` 的读取方。模型只需要 content block；checkpoint modality 检测也
只读取标准化后的 content block。第二份图片 payload 会确定性增加 message/checkpoint 的 JSON 序列化体积，但不提供
当前运行行为。Langfuse 对 HumanMessage 的提取只取 content，因此不能把 metadata 中这份副本算作已确认
的 tracing 重复。

### 3.2 Root compaction 按设计移除较旧图片

[`compactOrchestratorMessages`](../packages/pet-agent/src/agent/orchestrator/contextCompaction.ts) 只用
`readMessageText` 生成旧消息摘要，并在摘要完成后用 `RemoveMessage(REMOVE_ALL_MESSAGES)` 替换原
messages。默认只保留最后十条消息。

当较旧的图片消息落在被总结区间时：

- summary transcript 只包含其文本；
- 原始图片 block 被删除；
- checkpoint 中不再保留该图片上下文。

这是当前有损压缩的预期结果：压缩摘要替代旧消息，而不是永久保存旧消息中的每种模态。本轮不改变
该语义，也不把所有历史图片固定保留在 checkpoint 中。

### 3.3 Subagent summarization 不会展开普通用户图片

当前安装的 LangChain 使用 `getBufferString` 把被总结消息转换为文本。对标准 `image` block 和旧
`image_url(data:)` message 的实际输出都是 `[image]`，不会把 base64 展开进 summarization prompt。

当前 LangChain 的 built-in summarization 会直接保留 keep 区间内的原 message，并通过
`getBufferString` 把摘要区间中的图片表示为 `[image]`。因此现有 transient media marker、redaction 和
restore 是旧行为兼容层，可以删除；summary 失败校验是另一项职责，继续保留。

### 3.4 Tracing 会接收完整图片，但未证实导致模型超时

Langfuse callback 直接把真实模型输入写入 span，因此完整图片 payload 会进入 SDK 的异步媒体处理路径。
当前日志中的 `Error processing media item: fetch failed` 与此一致。

但 `LangfuseSpanProcessor.onEnd` 异步启动媒体处理并捕获错误，不等待它完成后才返回 model callback。
现有证据不能说明媒体上传错误造成了模型 `TimeoutError`；`runMap` / `No LLM run to end` 更可能是底层模型
已超时后出现的 tracing 收尾噪音。

是否屏蔽 trace 中的图片 payload 属于独立的 observability payload 与日志质量优化，不是当前模型超时的已确认
根因。

## 4. 保持不变的行为

本轮重构保持以下现有边界：

- 图片继续作为标准 `image` content block 进入 `HumanMessage`；
- 主消息继续由 `OrchestratorState.messages` 和 FileSaver checkpoint 保存；
- Entry Answer、Planner 和 Capability 继续获得各自现有的 main message 上下文；终态收口
  继续只接收结构化文本投影；
- Planner 继续消费 User Request 和 delegation state；
- `laneMessages` 继续把未分 lane 的主消息提供给 Capability subagent；
- root 与 subagent summarization 继续以摘要替代被折叠的旧消息；
- model profile 继续在 admission 时校验 image modality；
- Artifact、普通文件附件和 Toolkit Runtime 不在本轮调整范围内。

## 5. LangChain / LangGraph 能力判断

现有框架已经覆盖了大部分结构，不需要为图片另外建立一套 media runtime：

- LangChain message 提供跨 provider 的标准 content blocks。入口直接写入 `image` block，读取方使用
  `message.contentBlocks`；provider adapter 在模型边界转换为各 provider 的原生格式；
- LangGraph checkpointer 负责持久化 graph state。当前 `OrchestratorState.messages` + `FileSaver` 已经是
  合适的 canonical message 存储；
- LangChain `wrapModelCall` 可以只修改单次调用的 `request.messages`，不改变 checkpoint state，适合
  provider 适配、临时文本投影等 model context 工作；
- LangChain built-in summarization middleware 提供 trigger、keep 和自定义 token counter，其
  `RemoveMessage + summary + preservedMessages` 行为与项目当前有损压缩语义一致；
- `getBufferString` 已把图片表示为 `[image]`，built-in middleware 也会原样返回 keep 区间中的 messages；
  现有 transient screenshot marker 和 redaction/restore wrapper 不再提供必要语义。

`ToolMessage.artifact` 是不发送给模型的补充数据，不能替代用户图片所在的 message content。LangGraph
Store 面向跨 thread 的长期数据，也不是本轮缺失的媒体存储层。

因此本轮应继续复用框架的 message、checkpointer 和 built-in summarization，不新增媒体压缩层：

> **被 keep 的媒体保留原内容，被摘要的媒体按既有语义移除；普通图片在摘要输入中由 LangChain 表示为
> `[image]`。**

## 6. 最小重构方向

### 6.1 继续使用 LangChain 标准 content blocks

消息入口使用现代 LangChain 标准块 `{ type: 'image', mimeType, data }`，并把 message output version
标记为 `v1`。需要读取模态时使用 `message.contentBlocks`，不自行解析 provider-native 图片结构。当前
没有新增共享 helper 的必要；在出现第二个真实读取方后再提取。

当前安装的 OpenAI-compatible adapter 会对 v1 message 把该标准块转换成 provider 所需的 `image_url`，
因此 Kimi、Qwen 等 profile 无需在消息创建处维护分支。这个边界由 converter 行为测试覆盖。旧 checkpoint
中的 `image_url` 也会被 `message.contentBlocks` 归一为 `image`，modality 读取仍向后兼容。

### 6.2 去掉 metadata 中重复的图片 payload

`localImageReferences` 只保留展示与完整性 metadata：

```ts
{
  name,
  mimeType,
  byteSize,
  sha256,
}
```

`HumanMessage.content[].data` 是图片内容的唯一 message payload。兼容性测试确认 checkpoint modality、
OpenTUI v2 display 和 model input 都不依赖 metadata URI。

### 6.3 保持现有 compaction policy

Root compaction 已经通过 `readMessageText` 构造纯文本摘要输入，不会把图片 base64 发送给 summarizer；
它移除压缩区间中的旧图片是预期行为，本轮无需改动。

Subagent 继续使用 LangChain built-in summarization middleware，不另外实现 cutoff、keep、tool pair 或
state replacement。PinPawo 只在调用该 middleware 的边界处理媒体投影。

### 6.4 删除旧的 summarization 媒体兼容层

保留 LangChain built-in summarization 及现有 trigger、keep、token reserve 配置，同时删除：

- `markTransientModelMedia` / `isTransientModelMedia` 标记；
- summarization 前的 media redaction；
- summarization 后按 message id 恢复媒体的逻辑；
- browser screenshot 对该 marker 的依赖。

保留 `assertValidContextSummaryUpdate` 一类 summary 失败保护，因为它处理的是 destructive error update，
与媒体表示无关。

该重构只影响 Capability subagent 与 browser screenshot message 构造，不改变 orchestrator state、lane、
root compaction、Planner 或 Answer。

### 6.5 在 observability 边界隔离 tracing media

在 [`createLangfuseCallbacks`](../services/local-agent/src/langfuseTracing.ts) 边界验证 Langfuse SDK
提供的 input masking/media capture 配置。目标 tracing view 只需要：

- message role、id 和文本预览；
- 图片 MIME、字节数和 hash；
- model usage、cache details、耗时和错误；
- graph/model/tool 的 parent-child 关系。

当前使用的 `LangfuseSpanProcessor` 会先执行 `mask` 再处理媒体。如果决定不在 trace 中保留原图，可以在
该扩展点把图片 payload 投影为 MIME、字节数和 hash；该改动只改善 observability payload 和错误日志，不能
作为模型超时修复。

## 7. 实施顺序

### PR 1：收敛到 LangChain summarization

- 删除 transient media marker 与 redaction/restore wrapper；
- browser screenshot 直接产生标准图片 HumanMessage；
- 保留 summary 失败保护；
- 用行为测试覆盖摘要输入不含 base64、keep 后原图片仍存在、fold 后原图片被摘要替代。

### PR 2：统一标准 content block 并删除无效重复

- 用户图片与 browser screenshot 都写入 LangChain 标准 `image` block；
- modality 读取使用 `message.contentBlocks`；
- 删除 `localImageReferences[].uri`；
- 验证 message、checkpoint 和 OpenTUI v2 行为不变。

### PR 3：可选的 tracing payload 收敛

- 接入 Langfuse input masking；
- 验证 tracing view、usage 和 parent-child hierarchy；
- 明确该 PR 不宣称修复 provider timeout。

### PR 4：测量与决定

- 记录连续模型调用的请求字节数、`input_tokens`、`image_tokens`、`cached_tokens`、TTFT 和总耗时；
- 分别测试 tracing on/off 与 cache hit/miss；
- 根据数据决定是否需要进一步改变 inline 标准图片块表示。

## 8. 测试场景

### Message 创建

- 用户图片只在 `HumanMessage.content` 中保存一份 base64 payload；
- metadata 保留名称、MIME、大小和 hash；
- text-only profile 仍在 admission 阶段拒绝图片；
- session checkpoint modality 仍返回 `image`。

### Root compaction

- 图片消息早于默认十条保留窗口时，compaction 后按设计被摘要替代；
- summary prompt 不包含图片 base64；
- 最近保留窗口中的图片仍保留原 image block。

### Capability subagent

- 初次模型调用包含用户图片；
- 工具循环后的下一次模型调用仍包含用户图片；
- `getBufferString` 对普通用户图片输出 `[image]`，不包含图片 base64；
- lane reconciliation 不删除 parent main image message。

### Tracing

- tracing view 不包含 base64 payload；
- tracing 开关不改变实际 model messages；
- tracing backend 失败时 agent run 仍按模型结果完成；
- usage 和时延字段仍可观测。

## 9. 范围边界

- 只处理 OpenTUI v2 chat 已支持的 PNG、JPEG 和 WebP 用户图片；
- 保持 inline 标准 `image` block 为本轮 canonical representation；
- 不新增 media store、URI resolver 或跨设备附件协议；
- 不扩展 audio、video、PDF 和普通文件的模型输入；
- 不改变 Planner、User Request、message lane、Artifact 或 Toolkit Runtime contract；
- 不以减少模型实际需要的图片上下文作为性能手段。

## 10. 待确认问题

1. Langfuse span masking 的字段级投影是否能同时保留 usage 和 trace hierarchy？
2. `localImageReferences` 除去重复 URI 后是否仍值得保留，还是展示 metadata 也可从 admission 结果
   单独写入更小的字段？

## 11. 完成条件

本轮重构完成需要同时满足：

- 同一 message 内不再保存两份图片 payload；
- subagent summarization 不再维护 transient media marker 与 redaction/restore 兼容层；
- 当前 LangChain 下 summarizer 不处理完整 base64 的行为有测试证据；
- Capability 在 compaction 前及 keep 区间内持续获得用户图片；
- compaction 后的媒体去留继续符合 built-in keep / summary 结果；
- 没有新增 media store、resource lifecycle 或 Artifact contract；
- 性能数据足以判断是否需要下一阶段架构工作。

## 12. 实现对齐记录

| 日期 | 状态 | 对齐内容 |
|---|---|---|
| 2026-08-15 | draft | 根据当前图片 admission、message、orchestrator、subagent summarization、checkpoint 和 Langfuse callback 实现建立分析与最小重构范围。 |
| 2026-08-15 | corrected | 明确旧图片随有损压缩被摘要替代是既有设计；移除 pinned-media compaction 方案，只保留 summarizer 输入投影。 |
| 2026-08-15 | verified | 实测当前 LangChain `getBufferString` 对 data URL 图片只输出 `[image]`；删除普通图片 summarizer adapter 方案，并把 Langfuse 媒体错误与模型超时因果解耦。 |
| 2026-08-15 | simplified | 将删除现有 transient media marker 与 redaction/restore 兼容层列为第一优先级，直接依赖 built-in summarization 的标准消息行为；orchestrator 保持不变。 |
| 2026-08-15 | implemented | 用户图片与 browser screenshot 统一写入 LangChain v1 标准 `image` block；删除 metadata 中重复的 URI，checkpoint modality 改读 `message.contentBlocks` 并保留旧 `image_url` 兼容。 |
