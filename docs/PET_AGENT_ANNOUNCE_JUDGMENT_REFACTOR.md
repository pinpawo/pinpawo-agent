# 方案：subagent → main 的显式 handoff（两条 message queue 模型）

> 状态：调研 / 已与作者口头对齐设计模型，**未动代码**。
> 归属：独立 PR（不在 answer-node PR #233 内；#233 按现状合并）。
> 触发：#233 review 的 P2 #1/#2，连带暴露 `completionReason → announce` 的语义偏离；进一步重新框定为 handoff 边界问题。
> 状态生命周期命名与 task/run 拆分见 `docs/PET_AGENT_STATE_LIFECYCLE_REFACTOR.md`。本文只描述 announce/handoff 语义。

## 1. 问题的本质：两条独立的 message queue，handoff 边界模糊

main agent 的 messages 和 subagent 的 messages **本质是两条独立的 queue**。当前为了用一套 LangGraph state/checkpoint 统一管理，把它们**物理塞进同一个 `state.messages` 数组，靠 lane 区分**：

- subagent 启动：`laneMessages(state.messages, lane, ...)`（createAgentRuntime.ts:902）从数组里按 lane 切出 subagent 该看的 queue。
- main 视图：`mainConversationMessages`（无 lane 的那条）。

**lane 是存储层的复用技巧，不是概念层的真相。概念层是两条独立 queue。**

问题出在 handoff（subagent 把结果交回 main）这一步：当前用**“删旧的、修剪出 main”**来模拟边界，而不是一次真正的交付。

- `laneMessagesForStateUpdate`（messageLanes.ts:240）：当 `announce==='completed'` 时，把该 lane 的中间消息 `RemoveMessage` 删掉、留下原 announce。
- 这导致：① 删除时机绑死在 subagent 自标的 tag 上（边界由 subagent 单方面决定）；② 留下的 announce 仍带 `lane=capability:xxx`，是“lane 消息混在 main 里”，没真正转籍；③ progress 时不删 → 两条 queue 物理残留交叠（review #1 的裸 ToolMessage 残留就是副产品）。

## 2. 术语澄清（避免歧义）

- **announce**：subagent 运行结束时，那条承载结论/产出的消息（lane 里最后一条有文本的 AI 消息）。
- **中间 transcript**：同一 lane 里 announce 之外的所有消息 —— subagent 一步步搜索/调工具的过程脚印（AI+tool_calls、ToolMessage…）。是 subagent **自己 queue 的工作记忆**，与 main 无关。
- **completionReason**（`'natural' | 'limit_reached'`，createSubagent.ts:257/275）：subagent 的 **stop reason**（怎么停的），**不是**“成没成”。当前实现错误地把它 lossy 映射成 completed/progress 结论。

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

**对比当前**：现在是“subagent 自标 completed → 修剪函数顺便删一删，留下带 lane 的原 announce”。重构后是“decision 判定完成 → copy 一份干净副本进 main → 整条 lane 用完即焚”。

### progress（未完成）：流程完全不变

- decision 觉得没成 → **不 handoff**，按现在的流程继续走（续跑/ask）。
- main queue 此刻拿不到任何东西，subagent lane 原样保留（供续跑切回去）。
- **不需要把进度/中间过程交给 main**。从 main 视图看，事实就是“委派了任务、还没结果”，这个 context 真实自洽；基于“还没结果”回答用户可接受。

## 3a. 已定决策（实现前已拍板，消除歧义）

> 这些是与作者对齐后定下的、直接决定实现形状的点。实现时按此执行，不再重新讨论。

**D1 — handoff 的“完成”信号 = decision 的 `action` 本身，不新增 schema 字段、不读 completionReason。**
- decision 的 `action` 就是它的判定：`finish`=工作完成、收尾交付；`ask_user`=没完成、等用户；`delegate_*`=没完成、继续推进。
- 因此 **handoff 触发 = `actionKind === 'finish'`**。这是“判定权在 orchestrator”的正解：runtime 不再拿 `completionReason==='natural'` 自己推断完成（那只是把 stop reason 当判定，是要消灭的 lossy 映射的同一个病）。
- **单线 delegation 下，handoff 当前 `taskActiveDelegation`。** 这一轮若 `action=delegate_*`，属于“继续”，active delegation 的结果留在 lane 作为后续上下文，不 handoff；等到最终 `action=finish` 时，把当前 `taskActiveDelegation` handoff 进 main。早期草案里“遍历 `runDelegations`”的做法不再作为控制流来源；`runDelegations` 只能做本 run 的 prompt/debug 摘要。
- `completionReason` 仅作为线索喂进 decision 输入（见 D4），不参与 runtime 的 handoff 判定。

**D2 — 溯源 metadata：最小集。**
handoff 复制出的 main 消息，`additional_kwargs.pinpawo` 只带：
- `handoffFrom`: 来源 lane（`general` / `capability:<name>`）—— 哪个 capability/执行器交付的。
- `delegationId`: 哪次委派。
- `task`: 该委派的任务文本（已有，便于 main 侧理解“这是为什么委派产生的结果”）。
不带 `lane`（或显式 `lane` 缺省 = main 一等公民），不带 `announce`/`completionReason`（那些是旧判定语义，handoff 后不再需要）。

**D3 — 清空 lane 的粒度：只清该 delegationId。**
按 `lane + transcriptRunId + delegationId` 三者匹配清空（实现初期可以继续复用现有 `runId` 参数名，但调用方必须传 `taskActiveDelegation.transcriptRunId`），不波及同 lane 其它 delegation。原 announce + 该 delegation 的全部中间 transcript 一起 `RemoveMessage`。

**D4 — completionReason 退回纯 stop reason。**
`createSubagent.ts` 仍返回 `natural | limit_reached`，作为 decision 的**判断线索**（喂进 decision 输入），但**不再被映射成消息上的 completed/progress tag**。

**D5 — answer node 保留，只化简取数。**
- answer node 本身保留（#233 引入，decision 不再自出 answer）。
- `answerConversationMessages`（#233 引入，去 lane 里捞 completed+progress announce）**删除**；answer node 改回直接读 main queue（`mainMessagesWithoutCompaction`），因为 announce 已被 handoff 复制进 main。
- 保留 #233 已修的“answer 能看到 compaction summary”（review P2#1）：main 视图取数时不再过滤 compaction summary。

**D6 — progress 流程零改动。** 见 §3“progress（未完成）”。不引入任何新的 progress 表达；review P2#1（progress 裸 ToolMessage）因 progress 时无物进 main 而自然消失。

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

| 位置 | 现在做什么 | 重构后 |
|---|---|---|
| `tagNewLaneMessages` | 用 completionReason lossy 映射出 completed/progress tag | 不再下完成结论；至多保留“归属标记 + 哪条是 announce 文本”的中性标记 |
| `laneMessagesForStateUpdate` | completed 才删中间 transcript | 由 handoff 动作取代（copy + 清空 lane） |
| `answerConversationMessages`（#233 新增） | 去 lane 里捞 completed+progress announce | 不再需要；answer 直接读 main queue |
| `buildSubagentAnnounceContext`（prompts.ts:326） | 给 decision 喂 `状态：completed/progress`（先入为主） | 去掉“状态”，只喂 announce 文本 + completionReason 线索，让 decision 真正判 |
| `delegationOutcomeDecision` | 读已写死的 tag，做“追认” | 真正判定 completed/继续/ask，并触发 handoff |
| `createAgentRuntime.ts:675`、`delegations.ts:39` | 依赖 announce/turnDelegation 的 progress 状态 | 需改判据来源：未完成 delegation 由 `taskActiveDelegation` 表示；`runDelegations` 只保留本 run 摘要 |

## 6. 实现步骤（建议顺序，便于小步验证）

1. **新增 handoff 构造**（messageLanes 或新文件）：给定 existingMessages + 完成的 delegation 标识，产出 `[RemoveMessage(该 delegationId 的所有 lane 消息...), 新的 main announce 副本(带 D2 metadata)]`。这是纯函数，先单测。
2. **decision 写回接入 handoff**：在 `delegationOutcomeDecision` 的 state 写回处，对“本轮判定为完成（D1：active delegation 不再续跑）”的 delegation 执行步骤 1 的构造，并入 `messages` 更新。
3. **未完成 delegation 来源改为 task state**：新增 `taskActiveDelegation`，`status: 'awaiting_decision'` 表示 subagent 已返回、等待 orchestrator 判断。`runDelegations.status` 不再承担跨 run 生命周期职责。
4. **拆掉 lossy 映射**：`tagNewLaneMessages` 不再写 completed/progress；只保留归属标记（lane/runId/delegationId）+ 标出“哪条是 announce 文本”的中性标记。`laneMessagesForStateUpdate` 删除（被 handoff 取代）。
5. **decision 输入去“状态”**：`buildSubagentAnnounceContext` 去掉 `状态：completed/progress` 行，保留 announce 文本 + `停止原因：completionReason`。
6. **answer 取数化简**：删 `answerConversationMessages`，answer node 改读 `mainMessagesWithoutCompaction`（D5）。
7. 清理随之失效的导出/类型（`AnnounceKind` 是否还需要、`readRecentAnnounces` 是否仍被 discovery 用到等），按编译错误收口。

## 7. 验收标准（重构后必须成立）

- **完成即交付**：subagent 自然完成一次委派后，main queue **恰好多出一条** announce 副本，内容 = 原 announce 文本，带 `handoffFrom`/`delegationId`/`task` metadata；该 delegationId 的 lane 消息（原 announce + 中间 transcript）在 state 里**全部消失**。
- **完成 A 同时委派 B**：A 的 handoff 照常发生（不被 B 的新委派抑制）。
- **progress 不动 main**：limit_reached / decision 判未完成时，main queue **不变**，subagent lane 原样保留，可续跑。
- **answer 忠实复述**：用户要求“重发之前的结果”时，answer node 从 main queue 就能读到 handoff 副本，不再依赖 `answerConversationMessages`；旧的“压缩后仍可复述”测试仍通过。
- **decision 不再被先入为主**：decision 输入不含 `状态：completed/progress`，只有 announce 文本 + 停止原因。
- **无裸 ToolMessage 残留进 answer**：review P2#1 场景不再可复现。
- `npm run typecheck` + `npm test` 全绿；新增 handoff 纯函数单测 + 至少一个 graph 级 handoff 行为测试。

## 8. 不在本方案内

- review #2 的 token 预算（独立 follow-up，task_c86a3a9f）。
- subagent 内部 stop reason 的检测逻辑（createSubagent.ts 保持不变，它本就只该产出 stop reason）。
