# Context Governance 重构指导（issue #115）

> 状态：Spec v1（issue #115 讨论定稿）
> 日期：2026-06-13
> 关联：#115（本文档的事实来源）、#117（已合并，L2 的读取侧前置）、#75（explore，依赖 L1/L2）、#77（availableToolkits）。#114（L3 止血补丁）不合并——直接由 L4 取代，见第 5 节。

## 1. 问题与不变量

根因一句话：**`messages` 是只增不减的全量日志，并且以全量形态穿过每一层边界。**

| 层 | 症状 | 状态 |
|---|---|---|
| L1 子代理模型窗口 | `createSubagent` 是裸循环，无淘汰；每轮重发全量历史，token O(n²)，高迭代任务顶穿窗口 | 待实现 |
| L2 orchestrator state | lane 全量工具流水合入 `state.messages`；污染 compaction 触发逻辑；膨胀每个 checkpoint | #117 已做读取侧隔离；写侧折叠待实现 |
| L3 checkpoint 数量 | 每 super-step 全量快照，数量无界 | 不单独做——根因（全量快照）由 L4 内容寻址消除；#114 不合并 |
| L4 落盘 | 单 thread 拼一个 JSON 字符串，撞 V8 字符串上限 | git 式内容寻址布局为终态方案，直接落地 |

三条设计不变量，所有改动必须服从：

1. **结论过境，流水不过境**：原始工具输出只活在产生它的那一层；穿过边界的必须是结论形态（模型笔记、announce、handoff 的 previousReport），而不是工具流水。结论的体积由 subagent/context policy 控制；当前刚完成的 announce 不应在父 agent handoff 时再被替换成短 preview。
2. **策略是能力属性，不是全局属性**：淘汰策略通过 capability runtime 覆盖项声明；不声明 = 全保留，现有能力零行为变化。
3. **state 层与 memory 层分离**：checkpoint 是精确寻址、事务性、短生命周期的 KV；语义检索（explored memory）属于另一层，本文档不涉及。

## 2. 现状代码地图

| 关注点 | 位置 |
|---|---|
| 子代理执行循环（无淘汰、无窗口保护） | `packages/pet-agent/src/subagent/createSubagent.ts` |
| lane 合入 / announce 标记 | `packages/pet-agent/src/agent/orchestrator/messageLanes.ts` 的 `tagNewLaneMessages`、`laneMessages` |
| 委派状态更新（completed/progress） | `packages/pet-agent/src/agent/orchestrator/delegations.ts` 的 `updateTurnDelegationResult` |
| general/capability 节点（合入点） | `packages/pet-agent/src/agent/createAgentRuntime.ts` 的 `generalNode` / `capabilityNode` |
| compaction（只在 turn 开始跑） | `packages/pet-agent/src/agent/orchestrator/contextCompaction.ts` |
| 上下文窗口配置 | `services/local-agent/src/llmContextWindow.ts` |
| checkpoint 落盘 | `services/local-agent/src/fileSaver.ts` |

#117 已经落地的部分（不要重做）：`laneMessages` 按 lane+turnId+delegationId 三重过滤；`tagNewLaneMessages` 给每条 lane 消息盖 delegationId；续跑（progress/limit_reached 后 `reuseOrAppendTurnDelegation` 复用 delegationId）保留全量现场，新任务从零开始。注意 #117 只解决**读取侧泄漏**，state/checkpoint 的**体积**没有变小——这正是 L2 写侧折叠的活。

## 3. L2：completed 折叠（第一个动手项）

### 语义

- 委派状态变为 `completed` 的那一刻，该 delegationId 的 lane 消息**只保留 announce 一条**，其余全部清除——包括纯文本 AI 中间笔记。依据：完成后的下游消费者只有三个，全部只读 announce——决策节点（`readLatestAnnounce` / `readRecentAnnounces`）、compaction（`formatLaneAnnounceForSummary`）、handoff 转发（previousReport）。中间笔记的服务对象是"本任务的后续迭代"，任务完成即失去全部读者；结构化结果与长内容应在折叠前通过 `CapabilityArtifactRef` / `resultSchema` 定型，不依赖完成后的 lane transcript。
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

`compactContext` 的触发交给 `ProviderUsageWatermarkGuard`：读取 `mainConversationMessages` 中最近一次 provider 返回的
`usage_metadata.input_tokens`，与 `contextWindowTokens * triggerRatio` 比较。lane 噪音不参与触发；
本地不再估算 messages token，存储体积是另一个度量，不混用。

### 测试点

- 当次完成：合入 state 的消息只有 announce 一条。
- 续跑链：progress → 续跑（同 delegationId，transcript 完整）→ completed → 除 announce 外的旧消息全部被 RemoveMessage 清除。
- HITL 回归：委派中途 review interrupt → resume 正常（子代理内部状态在 checkpointer 的子 namespace 里，不受 state.messages 折叠影响——用 `npm run eval:hitl` 验证这个假设）。
- compaction 触发不再被 lane 噪音点燃（构造大量 lane 消息 + 少量主线消息，断言不触发）。

## 4. L1：上下文风险处理（全局）+ contextPolicy（能力级）

### 4.1 上下文风险处理（所有能力，故障处理而非遗忘）

不再在本地估算 messages token。上下文治理依赖 provider 实际返回的
`usage_metadata.input_tokens` 作为 prompt 水位信号：`ProviderUsageWatermarkGuard` 统一判断水位是否过线；
turn 开始的主线 compaction 与能力级 contextPolicy 都只消费 guard verdict。contextPolicy 本身只负责
在 guard 触发后对旧的大工具输出做 evict/truncate。真实窗口超限仍由 provider/model
返回错误；本地只保留不会伪装成 token 的结构性裁剪。

实现位置：`providerUsageWatermarkGuard.ts` 给出确定性水位 verdict；`contextCompaction.ts` / `contextPolicy.ts`
执行 compact 或 rewrite；`createSubagent.ts` 负责把 guard verdict 注入 `ContextPolicyContext`。

### 4.2 contextPolicy（第四个 runtime 覆盖项，能力级）

#### 设计前提：淘汰策略属于能力场景，不属于工具定义

同一个工具在不同能力里的上下文价值不同：一次 `grep_search` 在探索代码结构时可能只是可重跑的中间材料，在排错能力里也可能是关键证据。工具自身很难判断"旧结果是否可以被遗忘"；这个决策应由 capability/runtime 按任务场景声明。工具 metadata 只提供 `summarizeInput` / `summarizeOutput` 这类中性摘要能力，不承载淘汰策略。

**能力级声明策略（capability 作者声明收缩规则）**：

```ts
// CapabilityRuntime 新增可选项；capabilityNode 透传进 SubagentInput
contextPolicy?: {
  evictToolResults?: {
    keepRecent: number;          // 最近 K 次工具结果全文保留（recency 下限保护）
    budgetTokens?: number;       // 可选；默认使用当前 subagent 的 contextWindowTokens
    compressionThresholdRatio?: number; // 可选；默认 0.75
    minSizeChars?: number;       // 小于该值不淘汰（默认 2000）
    keepFailures?: boolean;      // 默认 true：失败结果永不淘汰
    perTool?: Record<string, 'keep' | 'evict' | 'truncate'>;
    // 工具名级覆盖，优先级最高；'truncate' 保留头部 minSizeChars 字符
  };
  rewrite?: (messages: BaseMessage[], ctx: ContextPolicyContext) => BaseMessage[];
  // 逃生舱：完全自定义改写，声明后 evictToolResults 失效；
  // ctx 提供迭代计数、operation metadata、latestProviderInputTokens、contextWindowTokens、
  // providerUsageWatermark guard verdict
};
```

水位 guard 条件：`latestProviderInputTokens >= floor((budgetTokens ?? contextWindowTokens) * compressionThresholdRatio)`。
`latestProviderInputTokens` 来自最近一次 provider model call 的 `usage_metadata.input_tokens`；因为 subagent
messages 是累积发送的，这个值就是上一轮实际送进模型的 prompt footprint。没有 provider usage metadata
时不触发压缩。

规则合成优先级（高到低）：`ProviderUsageWatermarkGuard` 触发 → `perTool` 覆盖 → `keepFailures` 保护 → `keepRecent` /
`minSizeChars` 体积规则。K 是地板（最近 K 次保留全文），旧的大体积可淘汰项从最老开始动手。

**capability_creator 的预设值（作为本规范的第一个校验用例）**：

```ts
contextPolicy: {
  evictToolResults: {
    keepRecent: 5,
    keepFailures: true,
  },
}
```

**能力级淘汰规则**——淘汰判据不是"旧"，而是"`ProviderUsageWatermarkGuard` 水位过阈值，且该能力声明了如何收缩旧工具结果"：

- **默认可淘汰**：声明了 `evictToolResults` 的能力中，旧的大体积成功工具输出可被替换为确定性存根：`[evicted: view_file_chunk src/foo.ts:1-200 → 已读；需要时重新调用]`。存根指纹优先复用 tool operation metadata 的 `summarizeInput`，但是否淘汰由 capability policy 决定。
- **按工具覆盖**：如果某个工具在该能力里必须保留、必须淘汰或只适合截断，由能力配置 `perTool`。工具定义本身不声明可淘汰性，避免工具越多策略越散。
- **永不淘汰**：失败结果（stderr/exit code 天然很小，是"别重犯这个错"的载体；判定：`ToolMessage.status === 'error'` 或文本 `^Error` 前缀）、AI 文本消息（模型自己的笔记）、存根本身（连成功调用也留"试过了"的记录）。
- **破坏性改写**：直接改写子代理消息状态，而不是只裁喂给模型的视图。收益：子代理返回的 transcript 天然有界（L2 的"未决保留窗口"自动有上界）；续跑时模型看到的现场与被打断前自己经历的窗口完全一致。
- **零 LLM 调用**：纯字符串规则。子代理循环内不做 LLM compaction（额外调用复杂度 + 有损，两条都被否决）。
- 配套 governing instruction 一行："较早的工具原始输出会被淘汰，重要发现要随时写进你的回复里。"

### 管道

`CapabilityRuntime` → `capabilityNode` → `SubagentInput`，与 #75 的 `model` / `maxIterations` 覆盖项同一条管道（三个一起加，types 改一次）。`contextWindowTokens` 同时透传给 subagent，作为能力未指定 `budgetTokens` 时的默认 budget。general lane 不声明 contextPolicy，保持全保留。tool operation metadata 随 `SubagentInput.operations` 进入淘汰器，仅用于生成稳定存根指纹，不决定是否淘汰。

### 测试点

- 淘汰规则单测：声明了 `contextPolicy` 的能力里，大的成功结果被存根化；小结果 / 失败 / AI 消息原样保留；K 地板生效；`perTool` 覆盖优先级最高。
- 缺省存根：用 `summarizeInput` 指纹兜底；没有摘要 metadata 时退回工具名 + 输入 JSON。
- `rewrite` 逃生舱：声明后声明式规则不再生效。
- 重复输入 guard：构造重复 messages，断言以 limit_reached 收场而非抛错。
- 不声明 contextPolicy 的能力：行为与现状逐字节一致。

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
② L1 repeated-input guard（全局）
③ L1 contextPolicy 机制 + 类型管道           （与 #75 的 model/maxIterations 覆盖同批）
④ L4 git 式 FileSaver                        （取代 L3；带上 F1/F2 约束。与 ①②③ 并行无依赖）

L3 不单独做（见第 5 节）；#114 不合并。
```

验收标准（按策略分别适用）：

- 声明 evictToolResults 的能力：30 轮读密集运行不会无限保留旧的大工具输出。
- 全保留能力：重复输入时以 limit_reached 体面收场（guard 覆盖）。
- 已完成委派在 `state.messages` 中只剩 announce 一条（工具消息和中间 AI 笔记均已清除）；checkpoint 体积由会话长度决定，不再由工具调用量决定。
- 同 turn 续跑（progress/limit_reached）拿到完整（L1 限界后的）现场；新任务从零开始（#117 已保证）。
- HITL 委派中途 resume 回归通过（`eval:hitl`）。
- compaction 不再被 lane 噪音触发，只由主线 provider `usage_metadata.input_tokens` 水位触发。

## 8. 明确不做（v1）

- 子代理循环内的 LLM compaction（确定性规则足够，拒绝额外调用与有损摘要）。
- 全局淘汰策略（默认全保留是正确契约）。
- ExploreResult schema 及其 orchestrator 消费链（汇报格式走 instruction 约定，消费方是下一个 LLM）。
- orchestrator 路由改动（explore 走 description 驱动的现有路由）。
- memory 层 / 向量化（依赖本重构 + #75 产出"值得记的东西"之后再立项）。
