# Context Governance 重构指导（issue #115）

> 状态：Spec v1（issue #115 讨论定稿）
> 日期：2026-06-13
> 关联：#115（本文档的事实来源）、#114/PR #114（L3/L4 止血）、#117（已合并，L2 的读取侧前置）、#75（explore，依赖 L1/L2）、#77（availableToolkits）

## 1. 问题与不变量

根因一句话：**`messages` 是只增不减的全量日志，并且以全量形态穿过每一层边界。**

| 层 | 症状 | 状态 |
|---|---|---|
| L1 子代理模型窗口 | `createSubagent` 是裸循环，无淘汰；每轮重发全量历史，token O(n²)，高迭代任务顶穿窗口 | 待实现 |
| L2 orchestrator state | lane 全量工具流水合入 `state.messages`；污染 compaction 触发估算；膨胀每个 checkpoint | #117 已做读取侧隔离；写侧折叠待实现 |
| L3 checkpoint 数量 | 每 super-step 全量快照，数量无界 | PR #114 封顶 40/namespace（review 修复待合） |
| L4 落盘 | 单 thread 拼一个 JSON 字符串，撞 V8 字符串上限 | PR #114 隔离止血；git 式布局为终态方案 |

三条设计不变量，所有改动必须服从：

1. **结论过境，流水不过境**：原始工具输出只活在产生它的那一层；穿过边界的必须是有界的结论形态（模型笔记、announce、handoff 的 previousReport）。
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
| 窗口估算设施 | `services/local-agent/src/llmContextWindow.ts`、`contextCompaction.ts` 的 `estimateMessagesTokens` |
| checkpoint 落盘 | `services/local-agent/src/fileSaver.ts` |

#117 已经落地的部分（不要重做）：`laneMessages` 按 lane+turnId+delegationId 三重过滤；`tagNewLaneMessages` 给每条 lane 消息盖 delegationId；续跑（progress/limit_reached 后 `reuseOrAppendTurnDelegation` 复用 delegationId）保留全量现场，新任务从零开始。注意 #117 只解决**读取侧泄漏**，state/checkpoint 的**体积**没有变小——这正是 L2 写侧折叠的活。

## 3. L2：completed 折叠（第一个动手项）

### 语义

- 委派状态变为 `completed` 的那一刻，把该 delegationId 的 lane 消息折叠为**纯文本 AI 消息**（中间结论 + announce），删除工具消息和带 tool_calls 的 AI 消息。
- `progress` / `limit_reached` 的委派**原样保留**（transcript-continuation 是被打断任务的生命线；它的 announce 只是最后一条 progress 文本，不是完整汇报）。
- 折叠时机选"完成时"而非"turn 结束时"：turn 内每个 super-step 都在写 checkpoint，晚折叠让整个 turn 的快照都背着死流水。

### 实现要点

折叠分两条路径，都在 `completed` 判定处触发：

1. **当次完成**（`capabilityNode`/`generalNode` 返回时 announce 即为 completed）：在 `tagNewLaneMessages` 之后、返回 state 之前，直接把本次新增消息过滤为纯文本 AI 消息。最简单，不需要 RemoveMessage。
2. **续跑后完成**（前几轮 progress 留下的旧流水，本轮才 completed）：旧消息已在 state 里，需要节点返回 `RemoveMessage`（按消息 id）清除该 delegationId 的历史工具消息。messages channel 的 reducer 会给无 id 消息补 uuid，但实现时要在写入侧确保 id 存在，避免删不掉。

过滤规则与读取侧 `toolProtocolSafeMessages` 保持自洽：删 tool 消息时必须同时删发起它的带 tool_calls 的 AI 消息，不留孤儿（读取侧虽会兜底丢弃孤儿，state 里也不应留垃圾）。

### 配套修正

`compactContext` 的触发估算改为对 `mainConversationMessages` 计算（现在对全量 `state.messages` 估，保护的却只是主线 prompt）。存储体积是另一个度量，不混用。

### 测试点

- 当次完成：合入 state 的消息不含 tool 消息；announce 文本保留。
- 续跑链：progress → 续跑（同 delegationId，transcript 完整）→ completed → 旧流水被 RemoveMessage 清除。
- HITL 回归：委派中途 review interrupt → resume 正常（子代理内部状态在 checkpointer 的子 namespace 里，不受 state.messages 折叠影响——用 `npm run eval:hitl` 验证这个假设）。
- compaction 触发不再被 lane 噪音点燃（构造大量 lane 消息 + 少量主线消息，断言不触发）。

## 4. L1：窗口保险丝（全局）+ contextPolicy（能力级）

### 4.1 保险丝（所有能力，故障处理而非遗忘）

子代理每轮模型调用前估算 messages token（复用 `estimateMessagesTokens` / `llmContextWindow.ts` 的窗口信息）；超过阈值（建议窗口的 85%）时不再发起调用，以 `limit_reached` 体面收场（announce progress），而不是 API 硬报错或被静默截断。

实现位置：`createSubagent.ts`。优先尝试 langchain 1.x `createAgent` 的 middleware/pre-model hook 挂载；若 API 不支持，把 `createSubagent` 改成自持 ReAct 循环（该文件本来就薄，自持循环同时为 contextPolicy 铺路）。

### 4.2 contextPolicy（第四个 runtime 覆盖项，explore 首个使用者）

```ts
// CapabilityRuntime 新增可选项；capabilityNode 透传进 SubagentInput
contextPolicy?: {
  evictToolResults?: {
    keepRecent: number;      // 最近 K 次工具结果全文保留（建议 5）
    minSizeChars: number;    // 只有大于阈值的才可淘汰（建议 2000）
    keepFailures: true;      // 失败结果永不淘汰
  };
}
```

**不对称可重取规则**——淘汰判据不是"旧"，是"可重取"：

- **可淘汰**：大体积的成功输出（文件读取、grep 命中——窗口成本的大头）。幂等可重取，且重读返回的是当前状态，自我修改之后比记忆更正确。替换为确定性存根，保留调用指纹 + 一行摘要：`[evicted: view_file_chunk src/foo.ts:1-200 → 已读；需要时重新调用]`。
- **永不淘汰**：失败结果（stderr/exit code 天然很小，是"别重犯这个错"的载体；判定：`ToolMessage.status === 'error'` 或文本 `^Error` 前缀）、AI 文本消息（模型自己的笔记）、存根本身（连成功调用也留"试过了"的记录）。
- **破坏性改写**：直接改写子代理消息状态，而不是只裁喂给模型的视图。收益：子代理返回的 transcript 天然有界（L2 的"未决保留窗口"自动有上界）；续跑时模型看到的现场与被打断前自己经历的窗口完全一致。
- **零 LLM 调用**：纯字符串规则。子代理循环内不做 LLM compaction（额外调用复杂度 + 有损，两条都被否决）。
- 配套 governing instruction 一行："较早的工具原始输出会被淘汰，重要发现要随时写进你的回复里。"

### 管道

`CapabilityRuntime` → `capabilityNode` → `SubagentInput`，与 #75 的 `model` / `maxIterations` 覆盖项同一条管道（三个一起加，types 改一次）。general lane 不声明 contextPolicy，保持全保留。

### 测试点

- 淘汰规则单测：大成功结果被存根化、小结果/失败/AI 消息原样保留、K 窗口滑动正确。
- 保险丝：构造超长 messages，断言以 limit_reached 收场而非抛错。
- 不声明 contextPolicy 的能力：行为与现状逐字节一致。

## 5. L3：checkpoint 数量封顶（收尾中）

PR #114 已实现每 namespace 保留 40 + flush 隔离。代码评审产出 F1–F6 修复（关键：F1 legacy 文件删除必须以 flush 全部成功为前提，否则动机场景下丢数据；F2 加载后立即裁剪 + 置 dirty），已在 worktree `pinpawo-agent-worktrees/fix-filesaver` 实现并通过 7 个测试，**待提交合并**。L2 落地后单快照变小，40 这个值可下调（构造参数已留好）。

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
- **prune/GC**：删 manifest（#114 的保留 K 策略原样迁移）；GC 从存活 manifest 标记可达 object，低频清扫（启动时即可）。
- **附带退役**：MemorySaver 继承（全库 RAM 镜像）、flush 定时器、dirty 标志、30 秒崩溃丢失窗口——每次 put 落盘即持久。
- **与 L2 联动**：折叠后的 blob 失去引用，GC 自然回收。
- **trade-off**：`setPinpetMeta` 原地改 meta 产生垃圾 blob（GC 兜底）；文件数用 git 两级散列目录，packfile 类比列为远期。

存储升级决策顺序（#115 评论已定，此处只引用）：本设计（精化"每 checkpoint 一文件"，零新依赖）→ Node 20→22 后用内置 `node:sqlite` 自定义 saver（同 schema 三张表）→ 官方 SqliteSaver（接受 better-sqlite3，换 sqlite-vec 给 memory 层）。

## 7. 实施顺序与验收

```
① L2 completed 折叠 + compaction 估算修正   （#117 已铺好 delegationId 基础，立即可做）
② L1 保险丝（全局）
③ L1 contextPolicy 机制 + 类型管道           （与 #75 的 model/maxIterations 覆盖同批）
④ L3 收尾：PR #114 + review 修复合并         （与 ①② 并行无依赖）
⑤ L4 git 式 FileSaver                        （存储再出问题或排期空闲时）
```

验收标准（按策略分别适用）：

- 声明 evictToolResults 的能力：30 轮读密集运行 token 近似线性增长，32k 窗口内完成。
- 全保留能力：接近窗口上限时以 limit_reached 体面收场（保险丝覆盖）。
- `state.messages` 不含已完成委派的工具消息；checkpoint 体积由会话长度决定，不再由工具调用量决定。
- 同 turn 续跑（progress/limit_reached）拿到完整（L1 限界后的）现场；新任务从零开始（#117 已保证）。
- HITL 委派中途 resume 回归通过（`eval:hitl`）。
- compaction 不再被 lane 噪音触发。

## 8. 明确不做（v1）

- 子代理循环内的 LLM compaction（确定性规则足够，拒绝额外调用与有损摘要）。
- 全局淘汰策略（默认全保留是正确契约）。
- ExploreResult schema 及其 orchestrator 消费链（汇报格式走 instruction 约定，消费方是下一个 LLM）。
- orchestrator 路由改动（explore 走 description 驱动的现有路由）。
- memory 层 / 向量化（依赖本重构 + #75 产出"值得记的东西"之后再立项）。
