# 方案：delegation state 分层澄清 + task-first 路由管道

> 状态：pinned direction（方向已定；Stage 0/0.5 已落地，Stage A/B 待实施）。
> 归属：issue #308（state 命名/生命周期）+ issue #274（任务分解与 capability 路由顺序）。
> 生命周期前缀规范以 `docs/PET_AGENT_STATE_LIFECYCLE_REFACTOR.md` §1/§2 为准，本文扩展其命名契约表。
> handoff 语义以 `docs/PET_AGENT_ANNOUNCE_JUDGMENT_REFACTOR.md` 为准，本文不改 handoff 模型。

## 1. 两个 issue，一个根因

- **#308**：`runPendingDelegation` / `taskActiveDelegation` / `runDelegations` / `runPendingFinalReply` 同时出现在日志/checkpoint 里，概念边界读不出来。
- **#274**：复合请求被打包成一个 `delegate_general` task。根因不只是 prompt——当前图的顺序是**先 capability search（query 来自完整原始请求），后生成 task**，顺序倒置：
  - search 的 query 被复合请求里所有步骤的关键词稀释，候选是"对整个请求的近似"而非"对当前步骤的匹配"；
  - task 在 `userIntentDecision` 最后一刻出生，且同一次输出还要选 lane，模型自然把整个请求塞进一个 task。

两个 issue 在同一批 state 字段上汇合：`taskActiveDelegation` 是任务游标、`runDelegationSummaries` 是结论账本、`runNextDelegation` 是下一跳命令。先澄清分层（#308），再在干净分层上改路由顺序（#274）。

## 2. 已钉住的决定（Decisions）

- **D1 — 生命周期前缀保留，不用注释替代。** 字段名会被序列化进 checkpoint 和 LangSmith trace，注释不会；`buildRunStateReset` 的 reset 纪律按名字执行。前缀编码生命周期（谁重置你），注释编码角色（命令/游标/账本），分工不二选一。新增一条单测断言所有 channel 名匹配 `/^(session|task|run)/` 或等于 `messages`。
- **D2 — 重命名遵守前缀规范**（#308 issue 正文里建议的 `nextDelegation`/`routePendingDelegation` 不合规，以本表为准），见 §3。
- **D3 — 不引入显式 taskPlan。** plan 的载体是「用户原始请求 + 已完成任务的结论（handoff copy + `runDelegationSummaries`）」，每轮决策重推；游标是 `taskActiveDelegation`。这是 #115 "conclusions cross boundaries" 的延伸。若 eval 证明跨轮丢步骤，预留 `remaining_work` 提示字段（备忘，非 source of truth），不进第一批 PR。
- **D4 — 图重构为 task → search → route 三段管道。** task 先出生，capability search 用 task 文本（+ 决策顺带输出的 `search_keywords`）做 query，路由决策最后落 lane。`capabilityDiscovery` 节点删除——它唯一的职责（LLM 从原始请求提炼 query）被"task 即 query"取代。
- **D5 — delegation outcome 决策收窄为三态** `continue | next_task | answer`，schema 不再携带 capability 枚举；capability 枚举只存在于 routeDecision 的小 schema。
- **D6 — routeDecision 只在零候选时走确定性 fallback**（直接 `general`），有候选一律过 LLM。不做"单一高分候选跳过 LLM"：词法打分置信度不足以定阈值。
- **D7 — `recoverTaskActiveDelegationFromRunState` 标注为 legacy checkpoint recovery**（服务 `taskActiveDelegation` 上线前的旧 checkpoint），注释写明删除条件：旧 checkpoint 超出保留期或下次 checkpoint 不兼容变更时删除。不为它引入版本号机制。
- **D8 — 单步任务约束随图重构落地**（进 taskDecision / outcomeDecision 的 prompt），不作为独立的 prompt-only PR。粒度标准："同一执行器、同一工具域内能连续完成的相邻动作算一步"，并明确禁止过度拆分。
- **D9 — `canHandoffActiveDelegation` 整字段删除，不改名。** 它是存进 state 的派生值：guard 逻辑是 `(taskActiveDelegation, messages)` 的纯函数（announce completionReason === 'limit_reached' → false），写者到唯一读者只有一跳，且派生输入在这一跳间不可变；decision context 已在为 announce context 计算同一个 completionReason。改法：`buildDecisionContext` 在 delegation_outcome 时就地 `evaluateGuard(delegationOutcomeDecisionGuard, ...)`（guard 定义与决策事件保留，观测面不丢），连带删除 `delegationOutcomeDecisionGuard` 图节点（薄包装）与 `prepareUserIntentDecision` 图节点（全部职责是写 true，而 run reset 已置 true、user_intent 读者硬编码忽略 state——双重死代码）。
- **D10 — `runPendingFinalReply` 在目标图中整字段删除，Stage 0 不改名。** 它与 D9 性质不同：不是可派生的 memo，而是真正的单跳路由信号（`'inline'` = 写者已发出最终消息；iteration guard 停止时还会清零 `runIterationCount`，读点无法重算），所以现状删不掉。但目标图里它的写入场景大部分蒸发：answer 路由由 `runPendingTask` 缺席派生；「指了不存在的 capability」「delegate 无 task 文本」被新 schema 杀死；存活的三个场景（无任何执行器、replacementBlocked、iteration limit）形状统一为「已发消息 → END」，改用 `Command({ goto: END })`（仓库已有先例：capabilitySearch tool 返回 Command）。Stage 0 对它只做 answer/inline 终点置 null 消日志噪音，不改名（改完就删是纯 churn）。

## 3. State 模型（目标）

命名契约（扩展 `PET_AGENT_STATE_LIFECYCLE_REFACTOR.md` §2 的表）：

| 现名 | 目标名 | 生命周期 | 角色 | 写方 | 读方 | 清空时机 |
|---|---|---|---|---|---|---|
| `runPendingDelegation` | `runNextDelegation` | run | **路由命令**（单跳） | routeDecision 节点 | `afterRouteDecision` + capability/general 节点 | 执行节点消费后置 null；run 入口 reset |
| `runPendingFinalReply` | **删除**（D10；Stage 0 不改名，仅终点置 null） | run→— | 路由信号；目标图中 answer 路由由 `runPendingTask` 缺席派生，「已回复 → END」改 `Command goto` | — | — | — |
| （新增） | `runPendingTask` | run | **任务命令**（管道内单段：decision → search → route） | taskDecision / outcomeDecision | capabilitySearch、routeDecision | routeDecision 落定后置 null；run 入口 reset |
| `runDelegations` | `runDelegationSummaries` | run | **账本**：只进 prompt/decision context，永不参与控制流分支 | 执行节点追加/更新 | `buildRunDelegationSummaryContext` | run 入口 reset |
| `runCapabilitySearchState` | 不变 | run | search 草稿；语义更新为**每个任务边界重置** | capabilitySearch 节点 | routeDecision | 任务边界（next_task）重置；run 入口 reset |
| `canHandoffActiveDelegation` | **删除**（D9） | — | 派生值误存为 state；改为 decision context 就地 evaluateGuard | — | — | — |
| `taskActiveDelegation` | 不变 | task | **任务游标**，唯一 active delegation source of truth | decision result + 执行节点 | `afterContextPrep`、decision context、handoff | 任务完成 handoff 时置 null |
| `messages` / `session*` | 不变 | session | — | — | — | 永不随 run 重置 |

`runPendingTask` 形状：

```ts
type RunPendingTask = {
  task: string;
  contextSummary: string | null;
  searchKeywords: string | null; // taskDecision 顺带输出，capabilitySearch 优先使用
};
```

补充约束：

- **transient 不跨 run 存活**：进入 END 前 `runNextDelegation` / `runPendingTask`（及 Stage 0 期间的 `runPendingFinalReply`）必须为 null，orchestrator 测试断言之。
- **`runDelegationSummaries` 只读不判**：route/guard 不得依据它分支（唯一现存例外是 D7 的 legacy recovery，带删除条件）。
- checkpoint 兼容：本次改名只涉及 `run*` 字段（run 入口本来就 reset），`taskActiveDelegation` 与 `session*` 不动，跨 run 状态不受影响。部署边界上处于 interrupt 中的 run 会丢路由 transient，接受（罕见，重新决策即可恢复），不做迁移。

## 4. Graph 设计（目标）

```
START → prepare → compactContext
  → afterContextPrep:
      taskActiveDelegation.status === 'awaiting_decision'
        → delegationOutcomeIterationGuard → delegationOutcomeDecision
          （handoff 许可 guard 由 decision context 就地评估，见 D9；不再是独立节点）
      否则 → taskDecision

taskDecision (LLM，静态 schema)
  输出 { action: 'answer' | 'next_task', task?, context_summary?, search_keywords? }
  ── 不含 capability 枚举；单步约束 prompt 在此
  → answer   → answerNode → END
  → next_task → 写 runPendingTask → capabilitySearch

capabilitySearch（确定性节点，无 LLM）
  query = runPendingTask.searchKeywords ?? runPendingTask.task
  → 写 runCapabilitySearchState → routeDecision

routeDecision（节点恒在，LLM 按需）
  零候选或未注册 capability：确定性写 runNextDelegation{lane:'general'}，跳过 LLM
  有候选：小 schema { lane: 'general' | 'capability.<name>' }（枚举仅来自本次候选）
  → 写 runNextDelegation、清 runPendingTask
  → afterRouteDecision → capability / general 执行节点

执行节点（不变）
  → 消费 runNextDelegation、更新 taskActiveDelegation/runDelegationSummaries
  → delegationOutcomeIterationGuard

delegationOutcomeDecision (LLM，静态 schema)
  输出 { outcome: 'continue' | 'next_task' | 'answer', task?, context_summary?, search_keywords? }
  ── continue：当前任务未完，同 lane 直达执行节点（复用 taskActiveDelegation.id/transcriptRunId，不重搜）
  ── next_task：当前任务完成、还有后续 → handoff + 清 taskActiveDelegation + 重置 runCapabilitySearchState
                → 写 runPendingTask → 汇入 capabilitySearch → routeDecision 管道（新 delegation id）
  ── answer：目标满足 → handoff → answerNode → END
```

要点：

- **两个 task 出生点（run 入口 taskDecision、任务边界 outcomeDecision）汇入同一条 search → route 管道**，per-task capability 匹配是结构保证，不靠 prompt 自觉。
- 现有 handoff 语义（announce/judgment 模型、`replacementBlocked` 守卫）不变，`next_task` 复用现有"answer 时 handoff + 清 lane"的同一套机制。
- LLM 调用数：现状 run 入口 2 次（capabilityDiscovery + userIntentDecision）；目标每任务 1 次（task 生成）+ 至多 1 次（route，零候选跳过）。未注册 capability 的部署退化为每任务 1 次。
- 迭代守卫：`runIterationCount` 维持 run 级预算（多任务共享），`DEFAULT_ORCHESTRATOR_MAX_ITERATIONS` 在 Stage B 落地时结合 eval 重新评估；不为任务边界回环单独计数（先简单，有数据再说）。
- 「已发出最终消息 → END」的路径（无任何执行器、replacementBlocked、iteration limit）由节点返回 `Command({ goto: END })`，不经 conditional edge 读 state（D10）；answer 正常路由由 `runPendingTask` 缺席派生。

## 5. Schema 变化

- `buildOrchestrationDecisionSchema` 的动态 capability 枚举移除：taskDecision / outcomeDecision 的 schema 变为**静态**（不再按候选重建），`delegate_capability.<name>` 动作值整体消失。
- 枚举只存在于 routeDecision 的小 schema，由当次 `runCapabilitySearchState.candidates` 构建。
- `parseAction` / `buildCapabilityActionName` / `STATIC_ACTION_KINDS` 随之收缩或删除。

## 6. 生命周期走查（#274 的复合请求示例）

「看 issue #269 → 分析需求点 → 搜本地代码/git log → 汇报结论」：

1. taskDecision：`next_task`，task=「获取 issue #269 内容并提炼需求点」（单步约束生效），search_keywords=「github issue|网页抓取」；
2. capabilitySearch 用 task 关键词匹配 → 假设命中 `web_reader` capability → routeDecision 选 `capability.web_reader`；
3. 执行 → announce → outcomeDecision：`next_task`，task=「在本地仓库检索相关实现与 git log，判断需求点是否已实现」→ handoff 任务 1 结论进 main，清游标，重搜；
4. capabilitySearch 零候选 → routeDecision 确定性 fallback `general`；
5. 执行 → announce → outcomeDecision：`answer` → handoff → answerNode 汇总两个任务的结论回复。

对照现状：同样请求今天是 1 个 `delegate_general` 大 task，search 只在入口跑一次且 query 混合了全部四步的关键词。

## 7. 实施顺序

| Stage | 内容 | 图改动 | 守护 |
|---|---|---|---|
| 0 | **已落地**：#308 重命名（§3 表；`runPendingFinalReply` 不改名，仅 answer/inline 终点置 null，见 D10）+ D7 注释 + channel 前缀单测 + transient 断言 + 更新 `PET_AGENT_STATE_LIFECYCLE_REFACTOR.md` §2 表 | 无 | 已由现有测试验收 |
| 0.5 | **已落地**：D9：删 `canHandoffActiveDelegation` 字段，guard 内联进 decision context，删 `delegationOutcomeDecisionGuard` / `prepareUserIntentDecision` 两节点 | 有（行为等价） | 现有测试 + guard 决策事件仍可观测 |
| A | 待实施：run 入口拆 taskDecision + capabilitySearch + routeDecision，删 capabilityDiscovery，新增 `runPendingTask`；单步约束 prompt 进 taskDecision | 有 | eval:route 等价性 + 新增复合请求 eval case |
| B | 待实施：outcomeDecision 三态化，`next_task` 汇入管道；迭代预算评估；删除 `runPendingFinalReply`（D10：inline 路径改 Command goto，answer 路由按 `runPendingTask` 缺席派生） | 有 | eval:flow + 「多步请求最终全部完成」断言（观测 plan drift，决定是否启用 D3 预留的 `remaining_work`） |
| B 捎带 | 待实施：`buildDecisionResult` 里 handoff/生命周期块下沉 `delegationLifecycle.ts` | 无 | 现有测试 |

## 8. 验收标准

- 日志/checkpoint 里所有 delegation 字段名自带生命周期与角色（#308 验收项全覆盖）。
- 复合请求产生 ≥2 个 delegation，每个 task 独立走 search+route（#274 验收）。
- 首个 task 文本不含编号步骤清单（eval 断言）。
- run 结束 snapshot 中 transient 字段全部为 null；Stage 0.5 后 `canHandoffActiveDelegation` 不再出现在 snapshot 中；Stage B 后 `runPendingFinalReply` 不再出现在 snapshot 中。
- Stage 0 不改变任何控制流行为；Stage 0.5 只移除派生 state，不改变 handoff 判定。

## 9. Non-goals

- 不引入显式 taskPlan / 多任务并发委派。
- 不改 handoff/announce 语义与 subagent 执行行为。
- 不做 checkpoint 迁移（理由见 §3 末）。
- 不合并 taskDecision 与 outcomeDecision 为单节点（职责已靠近，留待 Stage B 后按 eval 再议）。
