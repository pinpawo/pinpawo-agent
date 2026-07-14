# Context Governance 重构指导（issue #115）

> 状态：L1 已于 2026-07-14 修订；旧的 capability context policy / tool-result eviction 方案已替代
> 日期：2026-06-13
> 关联：#115（本文档的事实来源）、#117（已合并，L2 的读取侧前置）、#75（explore，依赖 L1/L2）、#77（availableToolkits）。#114（L3 止血补丁）不合并——直接由 L4 取代，见第 5 节。

## 1. 问题与不变量

根因一句话：**`messages` 是只增不减的全量日志，并且以全量形态穿过每一层边界。**

| 层 | 症状 | 状态 |
|---|---|---|
| L1 子代理模型窗口 | `createSubagent` 根据 `contextWindowTokens` 默认启用持久化摘要 | 已实现 |
| L2 orchestrator state | lane 全量工具流水合入 `state.messages`；污染 compaction 触发逻辑；膨胀每个 checkpoint | #117 已做读取侧隔离；写侧折叠待实现 |
| L3 checkpoint 数量 | 每 super-step 全量快照，数量无界 | 不单独做——根因（全量快照）由 L4 内容寻址消除；#114 不合并 |
| L4 落盘 | 单 thread 拼一个 JSON 字符串，撞 V8 字符串上限 | git 式内容寻址布局为终态方案，直接落地 |

三条设计不变量，所有改动必须服从：

1. **结论过境，流水不过境**：原始工具输出只活在产生它的那一层；穿过边界的必须是结论形态（模型摘要、announce、handoff 的 previousReport），而不是工具流水。当前刚完成的 announce 不应在父 agent handoff 时再被替换成短 preview。
2. **窗口预算属于 subagent runtime，不属于 capability/tool**：调用方只传 `contextWindowTokens`；`createSubagent` 统一派生摘要触发线和保留预算。capability 和 toolkit 不声明淘汰规则，也不接收 rewrite callback。
3. **state 层与 memory 层分离**：checkpoint 是精确寻址、事务性、短生命周期的 KV；语义检索（explored memory）属于另一层，本文档不涉及。

## 2. 现状代码地图

| 关注点 | 位置 |
|---|---|
| 子代理执行循环与默认摘要 middleware | `packages/pet-agent/src/subagent/createSubagent.ts` |
| lane 合入 / announce 标记 | `packages/pet-agent/src/agent/orchestrator/messageLanes.ts` 的 `tagNewLaneMessages`、`laneMessages` |
| 委派状态更新（completed/progress） | `packages/pet-agent/src/agent/orchestrator/delegations.ts` 的 `updateTurnDelegationResult` |
| general/capability 节点（合入点） | `packages/pet-agent/src/agent/createAgentRuntime.ts` 的 `generalNode` / `capabilityNode` |
| compaction（只在 turn 开始跑） | `packages/pet-agent/src/agent/orchestrator/contextCompaction.ts` |
| 上下文窗口配置 | `services/local-agent/src/llmContextWindow.ts` |
| checkpoint 落盘 | `services/local-agent/src/fileSaver.ts` |

#117 已经落地的部分（不要重做）：`laneMessages` 按 lane+turnId+delegationId 三重过滤；`tagNewLaneMessages` 给每条 lane 消息盖 delegationId；续跑（progress/limit_reached 后 `reuseOrAppendTurnDelegation` 复用 delegationId）保留全量现场，新任务从零开始。注意 #117 只解决**读取侧泄漏**，state/checkpoint 的**体积**没有变小——这正是 L2 写侧折叠的活。

## 3. L2：completed 折叠（第一个动手项）

### 语义

- 委派状态变为 `completed` 的那一刻，该 delegationId 的 lane 消息**只保留 announce 一条**，其余全部清除——包括纯文本 AI 中间笔记。依据：完成后的下游消费者只有三个，全部只读 announce——决策节点（`readLatestAnnounce`；全局 `readRecentAnnounces` recall 路径已在 PR #372 删除，completed announce 改由 main handoff 复制进主队列后经 `mainConversationMessages()` 消费）、compaction（`formatLaneAnnounceForSummary`）、handoff 转发（previousReport）。中间笔记的服务对象是"本任务的后续迭代"，任务完成即失去全部读者；结构化结果与长内容应在折叠前通过 `CapabilityArtifactRef` / `resultSchema` 定型，不依赖完成后的 lane transcript。
- **超出 announce 的收割走 `resultSchema` / result artifact，不要回头保留笔记**：announce 是给人/下游 LLM 读的自然语言结论，`kind: "result"` artifact（schema 校验后以 `CapabilityArtifactRef` 进 state）是给程序读的结构化收割通道——两者都在折叠前定型。将来 memory 层若要收割探索发现，正确做法是给该能力定义 `resultSchema`（与 #75 "ExploreResult schema 延后到需要时再做"对齐），而不是改折叠逻辑。折叠清掉的只是产生 announce / result 的过程性废料。
- **当前 completed announce 是完整 handoff 结果，不是 preview**：`delegation_outcome` / 父 agent 必须能读取刚返回 announce 的完整文本来判断是否 finish、是否继续委派、以及如何组织给用户的最终回复。`resultPreview`、最近任务列表、compaction summary 和 artifact preview 可以有界裁剪，但它们不能替代当前 completed announce 的文本。
- **artifact 不替代 announce，而是承载 announce 放不下或不该放的本体**：长结构化 JSON、长报告、图片/视频/PDF/文件包、跨 turn 复用资料，应在折叠前写成 `CapabilityArtifactRef`。此时 announce 仍要说明用户可读结论、关键发现、以及相关 artifact ref/title/preview；父 agent 默认只读 bounded artifact preview，不读 artifact 全文。
- `progress` / `limit_reached` 的委派**原样保留**（transcript-continuation 是被打断任务的生命线；它的 announce 只是最后一条 progress 文本，不是完整汇报）。
- 折叠时机选"完成时"而非"turn 结束时"：turn 内每个 super-step 都在写 checkpoint，晚折叠让整个 turn 的快照都背着死流水。

### 实现要点

折叠 = 只留 announce。分两条路径，都在 `completed` 判定处触发：

1. **当次完成**（`capabilityNode`/`generalNode` 返回时 announce 即为 completed）：`tagNewLaneMessages` 选定 announce 后，只把 announce 消息合入 state，其余本次新增消息直接不返回。最简单，不需要 RemoveMessage。
2. **续跑后完成**（前几轮 progress 留下的旧流水，本轮才 completed）：旧消息已在 state 里，需要节点返回 `RemoveMessage`（按消息 id）清除该 delegationId 除 announce 外的全部历史消息。messages channel 的 reducer 会给无 id 消息补 uuid，但实现时要在写入侧确保 id 存在，避免删不掉。

### 配套修正

`compactContext` 的触发改为读取 `mainConversationMessages` 中最近一次 provider 返回的
`usage_metadata.input_tokens`，与 `contextWindowTokens * 0.75` 比较。lane 噪音不参与触发；
本地不再估算 messages token，存储体积是另一个度量，不混用。

### 测试点

- 当次完成：合入 state 的消息只有 announce 一条。
- 续跑链：progress → 续跑（同 delegationId，transcript 完整）→ completed → 除 announce 外的旧消息全部被 RemoveMessage 清除。
- HITL 回归：委派中途 review interrupt → resume 正常（子代理内部状态在 checkpointer 的子 namespace 里，不受 state.messages 折叠影响——用 `npm run eval:hitl -w pinpawo-local-agent` 验证这个假设）。
- compaction 触发不再被 lane 噪音点燃（构造大量 lane 消息 + 少量主线消息，断言不触发）。

## 4. L1：上下文风险处理（orchestrator + subagent）

### 4.1 Orchestrator 主线

主线 compaction 仍是 orchestrator 图节点级行为。它读取最近主线 provider
`usage_metadata.input_tokens`，通过 guard 判断是否达到窗口水位，再由
`compactOrchestratorMessages` 执行。它不是 `createAgent` 的标准循环，不能直接换成 agent middleware。

### 4.2 Subagent 默认摘要

所有通过 `createSubagent()` 运行的 general/capability subagent 都使用同一条规则：

1. 调用方只传 `contextWindowTokens`；subagent 模型窗口与主模型不同时使用
   `subagentContextWindowTokens`。
2. `createSubagent()` 根据窗口派生内部 trigger/keep token budget。
3. LangChain `summarizationMiddleware` 在每次 model call 前计算消息体积；达到 trigger 后，用当前
   subagent model 总结较早消息，并通过 `RemoveMessage` 持久化替换 state。
4. 摘要保留当前任务、已完成工作、关键发现、决策、失败、待办及精确来源；近期消息保持原样。

trigger/keep 比例属于 runtime 内部保守常量，不进入 `CapabilityRuntime`。这样 system prompt、tool schema
和下一次模型输出始终有预留空间，同时公共配置只有一个窗口字段。

### 4.3 已删除的旧协议

以下接口不再存在：

- `SubagentContextPolicy` / `SubagentContextManagement`
- `ContextPolicyContext` / `ContextManagementContext`
- `rewrite` / `rewriteAsync` / `evictToolResults`
- subagent context watermark guard 和 capability 级 context policy
- 用于 in-loop artifact 写入的 `artifactSink`

工具输出的单次大小仍由 toolset/toolkit 自己负责。subagent 不按工具名配置 keep/evict/truncate；极端窗口压力由摘要整个旧执行上下文处理，而不是静默删除某类工具事实。

### 4.4 扩展边界

`SubagentRunInput.middleware` 保留为标准 LangChain middleware escape hatch。需要授权、重试、fallback
或其他真正的 agent 生命周期行为时，直接使用 `beforeModel`、`wrapModelCall`、`wrapToolCall` 等标准
hook，不再扩展 context policy DSL。

### 测试点

- 有 `contextWindowTokens` 且消息超过派生 trigger 时，旧历史被带 `lc_source: summarization` 的摘要持久化替换。
- 低于 trigger 时不产生摘要。
- general lane 与所有 capability 自动获得同一默认行为，无需 capability 显式配置。
- 单条 tool result 在未触发摘要时保持原样，输出大小责任仍在 toolkit。

## 5. L3：checkpoint 数量封顶（不做，直接上 L4）

**决定放弃 L3 这一层独立改动。** PR #114（每 namespace 保留 40 + flush 隔离）尚未合并；与其先合一个止血补丁、隔天又被 L4 取代，不如直接落 L4——内容寻址从根因（全量快照 = N 份 messages 拷贝）上消除了"必须靠砍数量止血"的前提，"数量"不再是需要防御的因子（blob 共享后多保留 checkpoint 几乎免费）。L4 一天内可落地（vibe coding），不值得为这个窗口期合 L3。

#114 的代码评审成果不浪费——它揭示的两条**正确性约束与全量/内容寻址无关，迁移到 L4 实现时必须带上**：

- **F1：写失败不得删旧数据。** 任何"用新布局取代旧文件"的迁移/重写路径，删除旧持久副本前必须确认新副本已完整落盘；任一 thread 序列化失败时保留旧文件，下周期重试。
- **F2：加载即应用保留策略。** 从盘上恢复后立即对超限内容执行裁剪/GC，否则已经超大的旧 thread 永远不会被瘦身，反复触发同一失败。

这两条在 L4 里对应：object 写 tmp+rename 确认成功后才更新 ref / 删旧 manifest（F1）；启动加载后立即跑一次 GC（F2）。

## 6. L4：git 式内容寻址 FileSaver（终态设计）

checkpoint 链与 git commit 模型同构（parent 指针 / 不可变快照 / latest+短链读取），直接借 git 的方案：

```
~/.pinpawo/checkpoints/
  objects/ab/cdef0123...        # 内容寻址：每条消息序列化后按 hash 存，不可变，可 gzip
  threads/<threadId>/
    refs/<ns>                   # 一行：最新 checkpoint id（rename 原子更新）
    manifests/<checkpoint_id>.json   # parent id + metadata + channel→hash 清单
```

- **put**：channel values 分解到消息粒度逐条 hash → 只写不存在的 object（tmp+rename）→ 写 manifest → 更新 ref。写入成本 ∝ 新增内容。
- **getTuple**：ref → manifest → 按 hash 取 object，按需懒加载。
- **prune/GC**：删 manifest（如需限制历史长度，保留最近 K 个 manifest）；GC 从存活 manifest 标记可达 object，低频清扫（启动时即可，满足 F2）。注意 blob 共享后多保留 manifest 成本极低，K 可以设得很大甚至不裁——L3 那种"为省钱牺牲历史"的权衡不再必要。
- **附带退役**：MemorySaver 继承（全库 RAM 镜像）、flush 定时器、dirty 标志、30 秒崩溃丢失窗口——每次 put 落盘即持久。
- **与 L2 联动**：折叠后的 blob 失去引用，GC 自然回收。
- **trade-off**：`setPinpetMeta` 原地改 meta 产生垃圾 blob（GC 兜底）；文件数用 git 两级散列目录，packfile 类比列为远期。

存储升级决策顺序（#115 评论已定，此处只引用）：本设计（精化"每 checkpoint 一文件"，零新依赖）→ Node 20→22 后用内置 `node:sqlite` 自定义 saver（同 schema 三张表）→ 官方 SqliteSaver（接受 better-sqlite3，换 sqlite-vec 给 memory 层）。

## 7. 实施顺序与验收

```
① L2 completed 折叠 + provider usage compaction  （#117 已铺好 delegationId 基础，立即可做）
② L1 guard registry 接入（详见 [Guard Design](./GUARD_DESIGN.md)）
③ L1 subagent 默认 summarization middleware
④ L4 git 式 FileSaver                        （取代 L3；带上 F1/F2 约束。与 ①②③ 并行无依赖）

L3 不单独做（见第 5 节）；#114 不合并。
```

验收标准（按策略分别适用）：

- 具有 `contextWindowTokens` 的 subagent：30 轮读密集运行会在窗口预算内生成可继续执行的持久摘要。
- 已完成委派在 `state.messages` 中只剩 announce 一条（工具消息和中间 AI 笔记均已清除）；checkpoint 体积由会话长度决定，不再由工具调用量决定。
- 同 turn 续跑（progress/limit_reached）拿到完整（L1 限界后的）现场；新任务从零开始（#117 已保证）。
- HITL 委派中途 resume 回归通过（`npm run eval:hitl -w pinpawo-local-agent`）。
- compaction 不再被 lane 噪音触发，只由主线 provider `usage_metadata.input_tokens` 水位触发。

## 8. 明确不做（v1）

- capability/tool 级 context policy 或按工具淘汰 DSL。
- ExploreResult schema 及其 orchestrator 消费链（汇报格式走 instruction 约定，消费方是下一个 LLM）。
- orchestrator 路由改动（explore 走 description 驱动的现有路由）。
- memory 层 / 向量化（依赖本重构 + #75 产出"值得记的东西"之后再立项）。
