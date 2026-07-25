# 方案：delegation state 分层澄清 + task-first 路由管道

> 状态：pinned direction（方向已定；Stage 0/0.5/A/B 已落地，B 捎带重构待实施）。
> 归属：issue #308（state 命名/生命周期）+ issue #274（任务分解与 capability 路由顺序）。
> 生命周期前缀规范以 `docs/PET_AGENT_STATE_LIFECYCLE_REFACTOR.md` §1/§2 为准，本文扩展其命名契约表。
> handoff 语义以 `docs/PET_AGENT_ANNOUNCE_JUDGMENT_REFACTOR.md` 为准，本文不改 handoff 模型。
> 修订 2026-07-09（#341 合并后）：Stage B 按「规划/验收垂直分离」重定义——D3/D5 改写、新增 D11
> 与 taskDecision → capabilitySearch → routeDecision 管道。设计依据：一个 LLM node 处理的东西越垂直，稳定性越好；pet-agent 只做
> 简单任务，复杂任务走 Studio planner。
> 修订 2026-07-11：删除 plan_draft；task_done 无条件回 taskDecision，
> route/guard 不再读取草案内容或存在性。
> 修订 2026-07-12（issue #349）：启动 capability-aware planning 的 eval-first 设计。
> Stage B 的无 plan 实现保持为 baseline；先通过评估确定 capability execution boundaries，
> 再引入独立 capabilityPlanner，并把 capabilitySearch + routeDecision 收口为 capabilityDecision。
> 修订 2026-07-12（issue #349 Phase 2）：上述目标 graph 已进入生产实现；本文早期章节中
> taskDecision → capabilitySearch → routeDecision 的描述保留为 Stage A/B 历史，不再是当前目标结构。

## 1. 两个 issue，一个根因

- **#308**：`runPendingDelegation` / `taskActiveDelegation` / `runDelegations` / `runPendingFinalReply` 同时出现在日志/checkpoint 里，概念边界读不出来。
- **#274**：复合请求被打包成一个 `delegate_general` task。根因不只是 prompt——当前图的顺序是**先 capability search（query 来自完整原始请求），后生成 task**，顺序倒置：
  - search 的 query 被复合请求里所有步骤的关键词稀释，候选是"对整个请求的近似"而非"对当前步骤的匹配"；
  - task 在 `userIntentDecision` 最后一刻出生，且同一次输出还要选 lane，模型自然把整个请求塞进一个 task。

两个 issue 在同一批 state 字段上汇合：`taskActiveDelegation` 是任务游标、`runDelegationSummaries` 是结论账本、`runNextDelegation` 是下一跳命令。先澄清分层（#308），再在干净分层上改路由顺序（#274）。

## 2. 已钉住的决定（Decisions）

- **D1 — 生命周期前缀保留，不用注释替代。** 字段名会被序列化进 checkpoint 和 LangSmith trace，注释不会；`buildRunStateReset` 的 reset 纪律按名字执行。前缀编码生命周期（谁重置你），注释编码角色（命令/游标/账本），分工不二选一。新增一条单测断言所有 channel 名匹配 `/^(session|task|run)/` 或等于 `messages`。
- **D2 — 重命名遵守前缀规范**（#308 issue 正文里建议的 `nextDelegation`/`routePendingDelegation` 不合规，以本表为准），见 §3。
- **D3（再次修订 2026-07-12）— 不恢复自然语言 plan_draft；评估 capability-aware plan。** Stage B 当前仍以「用户原始请求 + 当前 task/委托 + 已完成任务结论（handoff copy + `runDelegationSummaries`）」作为 baseline，`task_done` 回 taskDecision。issue #349 的后续方向是独立 capabilityPlanner：plan 描述 capability execution boundaries、依赖和 future task，不是文字步骤清单。新纪律是：plan 只有 capabilityPlanner 一个写方；entryDecision 不写 plan，outcomeDecision 不读 plan；guard/预算只读 task 总数、plan 修订次数等计数，不读 plan 内容做分支。Phase 1 先建立 `planner@entry` / `planner@boundary` eval，Phase 2 才修改生产 graph。
- **D4 — 图重构为 task → search → route 三段管道。** task 先出生，capability search 用 task 文本（+ 决策顺带输出的 `search_keywords`）做 query，路由决策最后落 lane。`capabilityDiscovery` 节点删除——它唯一的职责（LLM 从原始请求提炼 query）被"task 即 query"取代。
- **D5（修订 2026-07-09）— delegation outcome 决策验收化**：三态 `continue | task_done | goal_done` + 可选 `gap_note`，**不携带任何 task 文本字段**，也不携带 capability 枚举（枚举只在 routeDecision 小 schema）。它只回答一个问题——"这次 announce 的结果是否符合目标"：`continue` = 当前任务没达标，同 lane 继续（`gap_note` 说缺什么）；`task_done` = 这步达标但总目标未完；`goal_done` = 总目标满足。原三态里的 `next_task`（验收节点顺手写下一个 task）被否决：那让它同时干验收和规划两件事，prompt 会越写越长、稳定性下降。
- **D6（2026-07-26 修订）— capabilityDecision 只在存在 custom 候选时调用 LLM。** 零候选时，general tools 实际可用则确定性选择 `general`，否则确定性选择 `unavailable`。有候选时由 LLM 比较本次实际可用的执行能力，选择能够完成完整 task 且职责最贴合的一项；搜索命中只表示候选相关，不表示它能完成完整 task。
- **D7 — 删除 `recoverTaskActiveDelegationFromRunState`。** 它原本只服务 `taskActiveDelegation` 上线前的旧 checkpoint，但本轮把旧 `runDelegations` channel 改名为 `runDelegationSummaries` 后，旧 checkpoint 的 `runDelegations` 会被新图当作未知 channel 忽略；保留该 recovery 只会形成永远返回 null 的死代码。不做 checkpoint 迁移，旧 interrupt resume 重新决策。
- **D8 — 单步任务约束随图重构落地**（进 taskDecision / outcomeDecision 的 prompt），不作为独立的 prompt-only PR。粒度标准："同一执行器、同一工具域内能连续完成的相邻动作算一步"，并明确禁止过度拆分。
- **D9 — `canHandoffActiveDelegation` 整字段删除，不改名。** 它是存进 state 的派生值：guard 逻辑是 `(taskActiveDelegation, messages)` 的纯函数（announce completionReason === 'limit_reached' → false），写者到唯一读者只有一跳，且派生输入在这一跳间不可变；decision context 已在为 announce context 计算同一个 completionReason。改法：`buildDecisionContext` 在 delegation_outcome 时就地 `evaluateGuard(delegationOutcomeDecisionGuard, ...)`（guard 定义与决策事件保留，观测面不丢），连带删除 `delegationOutcomeDecisionGuard` 图节点（薄包装）与 `prepareUserIntentDecision` 图节点（全部职责是写 true，而 run reset 已置 true、user_intent 读者硬编码忽略 state——双重死代码）。
- **D10（修订 2026-07-10）— 删除 `runPendingFinalReply` 与 inline/finalizeRun 链路；所有用户可见终态统一经过 answer。** taskDecision 和 routeDecision 的下一跳可由已有业务 state 推导：有 `runPendingTask` 才进入 search，否则 answer；有 `runNextDelegation` 才进入 capability subagent，否则 answer。iteration guard 同样由 guard/state 决定 outcomeDecision 或 answer。outcomeDecision 的三态 verdict 既决定 state update 又决定下一节点，按 LangGraph 官方边界窄用 `Command({ update, goto })`：`continue` 回当前 capability，`task_done` 去 taskDecision，`goal_done` 去 answer；node 声明有限 `ends`，不引入新的 route state。删除 `runPendingFinalReply` channel/type/reset、`'inline'`、`buildInlineStopResult`、`finalizeRun` 及相关 route 分支。可预期终止由 answer 根据现有 state/guard 事实生成回复；真正 invariant violation 抛错或进入恢复，不由 decision/guard 代码直接写用户可见 `AIMessage`。
- **D11（修订 2026-07-11）— taskDecision 是唯一 task 出生点；`task_done` 无条件回环 taskDecision。** 垂直化推到底的结构结论：规划（"下一步怎么做"）全部收口在 taskDecision，验收（"结果符不符合目标"）全部收口在 outcomeDecision。任务边界流转为 `outcomeDecision(task_done) → handoff + 清 taskActiveDelegation + 重置 runCapabilitySearchState → taskDecision（用户目标 + 新结论）→ answer 或 capabilitySearch → routeDecision`。代价：每个 task_done 边界固定多一次 taskDecision LLM 调用；这正是规划/验收职责分离的结构成本。
- **D12（2026-07-12，2026-07-25 修订，取代 D4/D11 的当前 graph 结论）— capability-aware planning。** `entryDecision` 每个 run 只执行一次，选择 `answer | direct_task | needs_plan`；`capabilityPlanner` 是 future plan 内容的唯一写方，在 entry/boundary 两种输入分布下维护 capability execution boundaries，并分别输出 materialized `next_task` 与尚未开始的 `remaining_plan` tail。运行时把两者机械写入 `runPendingTask` / `runCapabilityPlan`，并把已完成 delegation 的任务目标和结果摘要作为只读 `completed_tasks` 注入 boundary；planner 结合这些事实、完整 latest handoff 和 tail 修订未来计划。`capabilityDecision` 在单节点内部完成搜索与 custom/general 选择；`task_done → handoff → capabilityPlanner(boundary)`，`goal_done → handoff → answer`。outcomeDecision 与 guard 均不读取 plan 内容。

## 3. State 模型（目标）

命名契约（扩展 `PET_AGENT_STATE_LIFECYCLE_REFACTOR.md` §2 的表）：

| 现名 | 目标名 | 生命周期 | 角色 | 写方 | 读方 | 清空时机 |
|---|---|---|---|---|---|---|
| `runPendingDelegation` | `runNextDelegation` | run | **路由命令**（单跳） | capabilityDecision | `afterDecision` + capability/general 节点 | 执行节点消费后置 null；run 入口 reset |
| `runPendingFinalReply` | **删除**（D10） | — | 纯路由 state；task/route 由业务 state 推导，outcomeDecision 窄用 Command | — | — | — |
| （新增） | `runPendingTask` | run | **当前待路由 task** | entryDecision（direct）或 capabilityPlanner（planned） | capabilityDecision | capabilityDecision 落定 delegation 后置 null；run 入口 reset |
| （新增） | `runCapabilityPlan` | run | **尚未开始的 capability execution boundary tail** | capabilityPlanner | capabilityPlanner | answer / run 入口清空；每次 planner 输出整体替换 tail |
| `runDelegations` | `runDelegationSummaries` | run | **账本**：只进 prompt/decision context，永不参与控制流分支 | 执行节点追加/更新 | `buildRunDelegationSummaryContext` | run 入口 reset |
| `runCapabilitySearchState` | **删除** | — | search candidates 改为 capabilityDecision 内部局部值，不进入 graph state | — | — | — |
| `canHandoffActiveDelegation` | **删除**（D9） | — | 派生值误存为 state；改为 decision context 就地 evaluateGuard | — | — | — |
| `taskActiveDelegation` | 不变 | task | **任务游标**，唯一 active delegation source of truth | decision result + 执行节点 | `afterContextPrep`、decision context、handoff | 任务完成 handoff 时置 null |
| `messages` / `session*` | 不变 | session | — | — | — | 永不随 run 重置 |

`runPendingTask` 形状：

```ts
type RunPendingTask = {
  task: string;
  contextSummary: string | null;
};

type CapabilityPlanTask = {
  objective: string;
  capabilityIntent: string;
};
```

补充约束：

- **transient 不跨 run 存活**：进入 END 前 `runNextDelegation` / `runPendingTask` 必须为 null、`runCapabilityPlan` 必须为空，orchestrator 测试断言之。
- **plan state 只保存 tail**：planner 用 `next_task` 单独 materialize current task，`remaining_plan` 从输出开始就只包含未开始的 future tail，并直接写入 `runCapabilityPlan`；task_done 后 boundary planner 读取 completed tasks + 完整 latest handoff + tail。
- **`runDelegationSummaries` 只读不判**：route/guard 不得依据它分支。
- **不从 lane announce 恢复 active delegation**：`taskActiveDelegation` 是唯一 active delegation source of truth；lane-tagged announce 只作为 transcript/context/handoff provenance，不再驱动控制流或候选恢复。
- checkpoint 兼容：本次改名只涉及 `run*` 字段（run 入口本来就 reset），`taskActiveDelegation` 与 `session*` 不动，跨 run 状态不受影响。部署边界上处于 interrupt 中的 run 会丢路由 transient，接受（罕见，重新决策即可恢复），不做迁移。

## 4. Graph 设计（目标）

```
START → prepare → compactContext
  → afterContextPrep:
      taskActiveDelegation.status === 'awaiting_decision'
        → delegationOutcomeIterationGuard → delegationOutcomeDecision
          （handoff 许可 guard 由 decision context 就地评估，见 D9；不再是独立节点）
      否则 → entryDecision

entryDecision（LLM，静态 schema；每个 run 只执行一次）
  输入：用户请求 + 主对话 + runDelegationSummaries 结论摘要
  输出 { action: 'answer' | 'direct_task' | 'needs_plan', task?, context_summary? }
  ── answer → Command(goto: answer)
  ── direct_task → 写 runPendingTask → Command(goto: capabilityDecision)
  ── needs_plan → Command(goto: capabilityPlanner)

capabilityPlanner（LLM，静态 schema；plan 内容唯一写方）
  entry 输入：用户目标 + capability registry；建立 capability execution boundaries
  boundary 输入：用户目标 + 已完成任务及结果 + 完整 latest handoff + 尚未开始的 runCapabilityPlan tail
  输出 { result: 'next_task' | 'answer', remaining_plan, next_task? }
  ── next_task → materialize 到 runPendingTask
                 → remaining_plan 直接写入 runCapabilityPlan tail
                 → Command(goto: capabilityDecision)
  ── answer → 清 plan → Command(goto: answer)

capabilityDecision（单节点内完成确定性 search + LLM selection）
  query = runPendingTask.task + contextSummary（含 capability intent）
  forcedCapabilityNames 存在时直接形成局部候选；否则 searchCapabilities
  零候选：general tools 可用则选择 general，否则选择 unavailable；跳过 LLM
  有候选：小 schema { selection: 'unavailable' | 'general' | 'capability.<name>' }
           其中 general 只在 general tools 实际可用时进入枚举
  ── general / capability → 写 runNextDelegation、清 runPendingTask
                           → afterDecision → capability / general 执行节点
  ── unavailable → 保留 runPendingTask、不创建 delegation → answer

执行节点（不变）
  → 消费 runNextDelegation、更新 taskActiveDelegation/runDelegationSummaries
  → delegationOutcomeIterationGuard

delegationOutcomeDecision (LLM，静态 schema) —— 验收节点（D5）
  输入：当前 task + announce 原文 + 用户原始请求（不读取 plan）
  输出 { outcome: 'continue' | 'task_done' | 'goal_done', gap_note? }
  ── continue：当前任务未达标，同 lane 直达执行节点（复用 taskActiveDelegation.id/transcriptRunId，
               不重搜；gap_note 作为续跑提示）
  ── task_done：当前 task 达标 → 完整 handoff + 清 taskActiveDelegation
                → Command(goto: capabilityPlanner boundary)
                → planner 修订 tail、materialize next task 或进入 answer
  ── goal_done：总目标满足 → handoff → answerNode → END
```

要点：

- **entry 与 boundary 分离**：entryDecision 只选择 run 的执行形态；所有 planned task 都由 capabilityPlanner materialize，task_done 不回 entry。
- **上下文垂直收窄**：entryDecision 只选 answer/direct/plan；capabilityPlanner 只维护 capability execution boundaries；capabilityDecision 只选执行 capability；outcomeDecision 只验收 announce。
- **plan 不驱动 route/guard**：`runCapabilityPlan` 只作为 capabilityPlanner 的上下文；outcomeDecision、conditional edge 与 guard 均不读取其内容分支。
- 现有 handoff 语义（announce/judgment 模型、`replacementBlocked` 守卫）不变，`task_done` 复用现有"answer 时 handoff + 清 lane"的同一套机制。
- LLM 调用数：run 入口固定 entry 1 次；需要 plan 时 entry 后增加 planner 1 次，每个 task_done boundary 再调用 planner；每个任务 capability selection ≤1 次、验收 1 次。
- 迭代守卫：`runIterationCount` 维持 run 级预算（多任务共享），`DEFAULT_ORCHESTRATOR_MAX_ITERATIONS` 在 Stage B 落地时结合 eval 重新评估；不为任务边界回环单独计数（先简单，有数据再说）。
- 所有正常终态统一进入 answerNode，由 answer 结合主对话、handoff 结论和已有 state/guard 事实生成唯一用户可见回复。entryDecision、capabilityPlanner 与 outcomeDecision 窄用带有限 `ends` 的 `Command({ update, goto })`；capabilityDecision 后用 `runNextDelegation` 的 conditional edge 进入执行 lane。不存在额外 final-reply route state，也不存在代码节点预先写最终消息再 `finalizeRun` 的旁路（D10）。

## 5. Schema 变化

- entryDecision：`{ action: 'answer' | 'direct_task' | 'needs_plan', task?, context_summary? }`；不含 capability 枚举或 search keywords。
- capabilityPlanner：`{ result: 'next_task' | 'answer', remaining_plan, next_task? }`；task 以 `objective + capability_intent` 表达，不绑定 registry capability id。
- capabilityDecision：`{ selection: 'unavailable' | 'general' | 'capability.<name>' }`；动态枚举只包含节点内部当次局部 custom 候选，`general` 仅在 general tools 实际存在时提供，`unavailable` 显式表示当前提供的能力都不能承担完整 task。
- outcomeDecision：`{ outcome: 'continue' | 'task_done' | 'goal_done', gap_note? }`；不含 task、plan 或 capability 字段。
- 旧 `delegate_*` 动作枚举、`search_keywords` 模型输出和 `runCapabilitySearchState` 全部退出当前生产契约。
- `parseAction` / `buildCapabilityActionName` / `STATIC_ACTION_KINDS` 随之收缩或删除。

## 6. 生命周期走查（#274 的复合请求示例）

「看 issue #269 → 分析需求点 → 搜本地代码/git log → 汇报结论」：

1. entryDecision 判断用户目标存在两个有意义的 capability execution boundaries，输出 `needs_plan`；
2. capabilityPlanner(entry) 输出 current task「获取 issue #269 内容并提炼需求点」和 future tail「结合需求点检查本地实现与 git log」；运行时 materialize 第一项，`runCapabilityPlan` 只保存 tail；
3. capabilityDecision 根据 current task 形成局部候选并选择读取/探索 capability；执行后 subagent announce；
4. outcomeDecision 验收 task 1 为 `task_done` → 完整 handoff 进入主对话，清 active delegation → capabilityPlanner(boundary)；
5. boundary planner 结合 completed task 事实和完整 issue 结论，把 future tail 具体化为「在本地仓库检索相关实现与 git log，判断需求点是否已覆盖」；
6. 新 current task 再次独立进入 capabilityDecision；零 custom 候选时根据 general tools 是否可用确定性选择 `general` 或 `unavailable`，否则在实际可用 executor 中选择；
7. 执行 → announce → outcomeDecision：若结论已满足用户目标，`goal_done` → handoff → answerNode；若当前 task 完成但是否仍有后续不明确，`task_done` → boundary planner 根据完整 handoff 和空 tail 选择 answer 或继续。

当前结构不会把用户文字步骤机械映射成 task，也不会把完整流程塞进一个 delegation；planner 按 capability execution boundary 组织任务，每个 materialized task 都独立经过 capabilityDecision。

## 7. 实施顺序

| Stage | 内容 | 图改动 | 守护 |
|---|---|---|---|
| 0 | **已落地（历史状态）**：#308 重命名 + 删除无效 legacy recovery（D7）+ channel 前缀单测 + transient 断言；当时增加的 inline 终点 flush 将按 D10 2026-07-10 修订整体删除 | 小 | 已由现有测试验收；D10 新路径需重写相关断言 |
| 0.5 | **已落地**：D9：删 `canHandoffActiveDelegation` 字段，guard 内联进 decision context，删 `delegationOutcomeDecisionGuard` / `prepareUserIntentDecision` 两节点 | 有（行为等价） | 现有测试 + guard 决策事件仍可观测 |
| A | **已落地**：run 入口拆 taskDecision + capabilitySearch + routeDecision，删 capabilityDiscovery，新增 `runPendingTask`；单步约束 prompt 进 taskDecision | 有 | orchestrator/schema/prompt 测试覆盖 task-first route |
| B | **本分支已完成**：outcomeDecision 验收化（D5）；task_done 一律回 taskDecision；删除 `plan_draft`、`runPendingFinalReply` 与 inline/finalizeRun，outcomeDecision 窄用 Command，其余路由由业务 state 的 conditional edge 推导；所有正常终态统一经过 answer（D3/D10/D11） | 有 | 多 task 回环、outcome 三态 Command 目的地、其余 conditional edge 与所有正常终态只产生一条 answer 回复均有测试覆盖 |
| C | **#349 Phase 2，本 PR 已实现**：entryDecision + capabilityPlanner(entry/boundary) + capabilityDecision；search 与 selection 合并；task_done 回 planner | 有 | Phase 1 decision contracts、planner scorer、multi-task graph eval 与 production graph 单测 |
| B 捎带 | 待实施：`buildDecisionResult` 里 handoff/生命周期块下沉 `delegationLifecycle.ts` | 无 | 现有测试 |

## 8. 验收标准

- 日志/checkpoint 里所有 delegation 字段名自带生命周期与角色（#308 验收项全覆盖）。
- 复合请求能根据用户目标与委托结论产生 ≥2 个 delegation；每个 task 独立经过 capabilityDecision（#274 验收）。
- 首个 task 文本不含编号步骤清单（eval 断言）。
- run 结束 snapshot 中保留的 transient 字段全部为 null；Stage 0.5 后 `canHandoffActiveDelegation` 不再出现，D10 修订后 `runPendingFinalReply` channel/type/reset 与 inline/finalizeRun 终点均不存在。
- Stage 0 不改变任何控制流行为；Stage 0.5 只移除派生 state，不改变 handoff 判定。
- Stage B：`plan_draft` / `runTaskPlanDraft` 不存在；`task_done` 无条件回 taskDecision；outcomeDecision schema 不含 task 文本字段（D5）；第 2+ 个 task 由回环后的 taskDecision 结合用户目标和委托结论产出并独立走 search+route（D11）。
- Stage C：entryDecision 只在 run 入口执行；future plan 内容只有 capabilityPlanner 一个写方，planner 分别输出 current `next_task` 与 future `remaining_plan`；runCapabilityPlan 只保存未开始 tail；task_done 回 capabilityPlanner boundary 并读取 completed tasks + 完整 latest handoff；每个 current task 统一经过 capabilityDecision；outcomeDecision/guard 不读取 plan 内容；answer 清空 runCapabilityPlan。

## 9. Non-goals

- 不恢复旧的自然语言 `plan_draft`，不把用户文字步骤机械映射成 task，不做多任务并发委派。
- planner 不提前绑定具体 capability id；实际执行者由 capabilityDecision 根据当时 registry 决定。
- 不跨 task 复用 capability subagent lane messages；结论只通过 announce/handoff 穿过 task boundary。
- 不改 handoff/announce 语义与 subagent 执行行为。
- 不做 checkpoint 迁移（理由见 §3 末）。
- 不合并 taskDecision 与 outcomeDecision 为单节点——D5/D11 后两者职责正交（规划 vs 验收），合并不再是方向。
- 不复制 Studio 的多角色任务队列；pet-agent planner 只组织自身 capability subagent 的执行边界。
