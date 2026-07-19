# 方案：subagent → main 的显式 handoff（两条 message queue 模型）

> 状态：已实现；2026-07-19 按显式 `announceMessageId` 与严格 provenance 协议修订。
> 归属：announce / handoff 的 canonical 语义说明。
> 触发：#233 review 的 P2 #1/#2，连带暴露 `completionReason → announce` 的语义偏离；进一步重新框定为 handoff 边界问题。
> 状态生命周期命名与 task/run 拆分见 `docs/PET_AGENT_STATE_LIFECYCLE_REFACTOR.md`。本文只描述 announce/handoff 语义。

本文只依赖消息身份与 metadata，不根据消息正文是否类似
`<delegation_briefing>`、`【委派简报】` 或其他文本形状判断消息角色。当前协议不为缺少
lane、delegationId、message id 或 handoff provenance 的旧 checkpoint 猜测身份。

## 1. 问题的本质：两条独立的 message queue，handoff 边界模糊

main agent 的 messages 和 subagent 的 messages **本质是两条独立的 queue**。当前为了用一套 LangGraph state/checkpoint 统一管理，把它们**物理塞进同一个 `state.messages` 数组，靠 lane 区分**：

- subagent 启动：`laneMessages(state.messages, lane, runId, delegationId)` 从数组里按身份切出 subagent 该看的 queue。
- main 视图：`mainConversationMessages`（无 lane 的那条）。

**lane 是存储层的复用技巧，不是概念层的真相。概念层是两条独立 queue。**

历史问题出在 handoff（subagent 把结果交回 main）这一步：旧实现用**“删旧的、修剪出 main”**来模拟边界，而不是一次真正的交付。

- 旧 `laneMessagesForStateUpdate` 在 `announce==='completed'` 时删掉中间消息、留下原 announce。
- 这导致：① 删除时机绑死在 subagent 自标的 tag 上（边界由 subagent 单方面决定）；② 留下的 announce 仍带 `lane=capability:xxx`，是“lane 消息混在 main 里”，没真正转籍；③ progress 时不删 → 两条 queue 物理残留交叠（review #1 的裸 ToolMessage 残留就是副产品）。

## 2. 术语澄清（避免歧义）

- **announce**：subagent 自然结束时明确选定的交付消息。`createSubagent` 只在最终消息是
  无 tool call 的 `AIMessage` 时返回其 `announceMessageId`；后续节点按该 ID 标记和交付，
  不再扫描“最后一条有文本的 AI 消息”。
- **delegation briefing**：orchestrator 向 selected subagent 派发的任务边界。`DelegationSpec`
  是事实来源，`materializeDelegation()` 确定性渲染 lane-scoped XML；runtime 不反向解析 XML。
- **main plan**：initial delegation 同时写入 main 的简短用户可见计划。continuation 只更新原
  lane briefing/gap，不重复写 main plan。
- **中间 transcript**：同一 lane 里 announce 之外的所有消息 —— subagent 一步步搜索/调工具的过程脚印（AI+tool_calls、ToolMessage…）。是 subagent **自己 queue 的工作记忆**，与 main 无关。
- **completionReason**（`natural | limit_reached | error`）：subagent 的 **stop reason**（怎么停的），**不是**“成没成”。当前实现只把它作为 outcomeDecision 线索，不再 lossy 映射成 completed/progress 结论。

## 3. 目标模型：handoff 由 decision 触发的显式动作

```
subagent → delegationOutcomeDecision → main
                     ↑
   只有 decision 判定 "subagent 完成了" 这一刻，才执行 handoff。

handoff 动作（在 delegationOutcomeDecision 写回 state 的同一步内做，不加新节点）：
  ① 把 announce 内容【复制】成一条新的 main queue 消息
       - 复制（copy），不是改 metadata 把原消息“转籍”
       - 新消息带最小溯源 metadata：哪个 capability/lane、哪次 delegationId
         （语义：“这条 announce 是 <capability> 为 <task> 交给 main 的”）
       - 它是 main 的一等公民（无 lane / lane=main）
  ② 该 subagent lane 的消息【全部清空】（原 announce + 全部中间 transcript 一起焚毁）
```

**对比历史实现**：过去是“subagent 自标 completed → 修剪函数顺便删一删，留下带 lane 的原 announce”。当前是“decision 判定完成 → copy 一份干净副本进 main → 整条 lane 用完即焚”。

### progress（未完成）：流程完全不变

- decision 觉得没成 → **不 handoff**，按现在的流程继续走（续跑/ask）。
- main queue 此刻拿不到任何东西，subagent lane 原样保留（供续跑切回去）。
- **不需要把进度/中间过程交给 main**。从 main 视图看，事实就是“委派了任务、还没结果”，这个 context 真实自洽；基于“还没结果”回答用户可接受。

## 3a. 已定决策（实现前已拍板，消除歧义）

> 这些是与作者对齐后定下的、直接决定实现形状的点。实现时按此执行，不再重新讨论。

**D1 — handoff 的“完成”信号 = outcomeDecision 的 verdict，不读 completionReason。**
- outcomeDecision 的 `outcome` 就是验收判定：`continue`=当前 task 未完成；
  `task_done`=当前 task 完成、总目标仍需下一 task；`goal_done`=总目标完成。
- 因此 **handoff 触发 = `task_done | goal_done`**。runtime 不拿
  `completionReason==='natural'` 自己推断完成；natural 只表示 subagent 正常停止。
- 单线 delegation 下只 handoff 当前 `taskActiveDelegation`。`continue` 保留 lane 并继续同一
  delegation；`runDelegationSummaries` 只是本 run 的 prompt/debug 摘要，不作为 unfinished task
  的控制流来源。
- `completionReason` 仅作为线索喂进 decision 输入（见 D4），不参与 runtime 的 handoff 判定。

**D2 — 溯源 metadata：最小且足以确定身份。**
handoff 复制出的 main 消息，`additional_kwargs.pinpawo` 带：
- `handoffFrom`: 来源 lane（`general` / `capability:<name>`）—— 哪个 capability/执行器交付的。
- `delegationId`: 哪次委派。
- `runId`: 该 delegation transcript 所属 run。
- `task`: 该委派的任务文本（已有，便于 main 侧理解“这是为什么委派产生的结果”）。
- `announceMessageId`: 被验收并复制的原始 announce 消息 ID，用于 provenance 与幂等判断。
不带 `lane`（或显式 `lane` 缺省 = main 一等公民），不带 `announce`/`completionReason`（那些是旧判定语义，handoff 后不再需要）。

**D3 — 清空 lane 的粒度：只清该 delegationId。**
按 `lane + transcriptRunId + delegationId` 三者匹配清空（实现初期可以继续复用现有 `runId` 参数名，但调用方必须传 `taskActiveDelegation.transcriptRunId`），不波及同 lane 其它 delegation。原 announce + 该 delegation 的全部中间 transcript 一起 `RemoveMessage`。

**D4 — completionReason 退回纯 stop reason。**
协议类型保留 `natural | limit_reached | error`；当前 `createSubagent` 正常路径产出
`natural | limit_reached`，作为 decision 的**判断线索**（喂进 decision 输入），但**不再被映射成消息上的 completed/progress tag**。

**D5 — answer node 保留，只化简取数。**
- answer node 本身保留（#233 引入，decision 不再自出 answer）。
- `answerConversationMessages`（#233 引入，去 lane 里捞 completed+progress announce）**删除**；answer node 直接读 main queue，因为 announce 已被 handoff 复制进 main。
- 当前实现统一读 `mainConversationMessages()`：按 lane metadata 排除执行器私有消息，同时保留
  main compaction summary。answer 不解析 briefing 正文，也不对模型输出做 briefing 文本匹配、重试或替换。

**D6 — 未完成流程不交付。** outcomeDecision 返回 `continue` 或 subagent
`limit_reached` 尚不可 handoff 时，不向 main 写入交付，原 lane 保留用于续跑。

## 4. 这个模型收敛掉的纠结点

| 之前的问题 | 在 handoff 模型下的归宿 |
|---|---|
| tag 怎么打 / 何时打 | 不再需要 subagent 侧的 completed tag。完成 = decision 触发 handoff |
| `completionReason→announce` lossy 映射 | 消失。completionReason 退回纯 stop reason，作为 decision 的判断线索 |
| answer node “过滤再拼回” / `answerConversationMessages` | 大概率整段删掉。announce 已被 handoff 复制进 main，answer 直接看 main queue |
| review #1（progress 裸 ToolMessage 被过滤丢失） | 消失。progress 时无任何东西进 main，main queue 不会出现 subagent lane 消息 |
| review #2（compaction token 预算） | 仍正交、独立 follow-up（task_c86a3a9f）；但 answer 视图变小（只看 main+副本，不再额外捞所有 lane announce），实际**缓解**了 #2 |
| `laneMessagesForStateUpdate`（删旧修剪） | 被 “handoff = copy + 清空 lane” 取代 |

## 5. 改动影响面（已确认的耦合点）

| 位置 | 历史实现 | 当前实现 |
|---|---|---|
| `tagNewLaneMessages` | 用 completionReason lossy 映射出 completed/progress tag | 按 `announceMessageId` 标记交付消息；不从正文推断，也不下完成结论 |
| `laneMessagesForStateUpdate` | completed 才删中间 transcript | 由 handoff 动作取代（copy + 清空 lane） |
| `answerConversationMessages`（#233 新增） | 去 lane 里捞 completed+progress announce | 不再需要；answer 直接读 main queue |
| `buildSubagentAnnounceContext`（prompts.ts:326） | 给 decision 喂 `状态：completed/progress`（先入为主） | 去掉“状态”，只喂 announce 文本 + completionReason 线索，让 decision 真正判 |
| `delegationOutcomeDecision` | 读已写死的 tag，做“追认” | 判定 `continue/task_done/goal_done`，完成 verdict 触发 handoff |
| delegation state | 依赖 announce/runDelegations 的 progress 状态 | 未完成 delegation 由 `taskActiveDelegation` 表示；`runDelegationSummaries` 只保留本 run 摘要 |

## 6. 当前落地形态

1. `createSubagent` 返回显式 `announceMessageId`。
2. `tagNewLaneMessages` 按 ID 标记 announce，并给新增消息写入 lane/runId/delegationId。
3. `buildSubagentHandoff` 按当前 active delegation 构造 main copy 与 lane `RemoveMessage`。
4. outcomeDecision 的 completed verdict 把 handoff update 写入 state；`continue` 只追加 continuation briefing。
5. answer 统一读取 `mainConversationMessages()`。

## 7. 验收标准（重构后必须成立）

- **验收完成即交付**：subagent 产生 announce 且 outcomeDecision 判定 `task_done/goal_done`
  后，main queue **恰好多出一条** announce 副本，内容 = 原 announce 文本，带
  `handoffFrom`/`delegationId`/`runId`/`task`/`announceMessageId` metadata；该 delegationId
  的 lane 消息（原 announce + 中间 transcript）在 state 里**全部消失**。
- **完成 A 同时委派 B**：A 的 handoff 照常发生（不被 B 的新委派抑制）。
- **progress 不动 main**：limit_reached / decision 判未完成时，main queue **不变**，subagent lane 原样保留，可续跑。
- **answer 忠实复述**：用户要求“重发之前的结果”时，answer node 从 main queue 就能读到 handoff 副本，不再依赖 `answerConversationMessages`；旧的“压缩后仍可复述”测试仍通过。
- **decision 不再被先入为主**：decision 输入不含 `状态：completed/progress`，只有 announce 文本 + 停止原因。
- **无裸 ToolMessage 残留进 answer**：review P2#1 场景不再可复现。
- **正文不决定身份**：合法 handoff 即使正文类似 briefing 也仍是 main conversation；普通 main
  消息也不会因为正文前缀被过滤。旧 checkpoint 缺少当前 provenance 时不做内容推断兼容。
- `npm run typecheck` + `npm test` 全绿；新增 handoff 纯函数单测 + 至少一个 graph 级 handoff 行为测试。

## 8. 不在本方案内

- review #2 的 token 预算（独立 follow-up，task_c86a3a9f）。
- subagent 内部 stop reason 的检测逻辑（createSubagent.ts 保持不变，它本就只该产出 stop reason）。
