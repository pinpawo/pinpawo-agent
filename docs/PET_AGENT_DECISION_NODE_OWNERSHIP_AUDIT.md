# pet-agent decision node 职责摸排

> 状态：历史审计记录；prompt ownership 与动态上下文边界已落地，`plan_draft` 已于 2026-07-11 删除。
> 范围：taskDecision、capabilitySearch、routeDecision、outcomeDecision，以及它们前后的 guard、state patch 和 conditional route。
> 目标：区分语义判断与确定性状态机，明确哪些事情交给 LLM，哪些事情必须由 node/graph 代码保证。
> 注：第 3–7 节保留删除前的问题证据；其中涉及 `plan_draft` 的描述不代表当前实现。

## 1. 判断原则

LLM 只处理无法从 state 确定推导的语义问题：

- 用户当前是否还需要执行。
- 当前一个 task 应该是什么。
- capability 描述是否语义匹配当前 task。
- announce 是否满足当前 task，以及用户目标是否还需执行。

node/graph 代码处理所有可以从 state、config、schema 或 guard 确定推导的问题：

- 当前是否允许进入某个 decision。
- 当前属于哪个 run/plan 模式。
- 哪些 capability 实际可用。
- 空候选、缺失 task、缺失 active delegation 等异常状态。
- iteration limit、handoff availability 和 forced capability。
- 模型结果如何写 state、如何路由、何时停止。

system prompt 可以描述 orchestrator 的共同架构，但不能成为状态机规则的唯一执行者。确定性规则即使出现在 shared prefix 中，也只是帮助模型理解上下文；真正的 enforcement 必须在代码中。

## 2. 当前执行链

```text
prepare / compactContext                         code guard + compaction
  -> afterContextPrep                           code route
  -> taskDecision                               LLM + code normalization
  -> capabilitySearch                           code search
  -> routeDecision                              code fast path 或 LLM + code validation
  -> capability subagent                        execution
  -> delegationOutcomeIterationGuard            code guard
  -> outcomeDecision                            LLM + code state transition
  -> afterDelegationOutcomeDecision             code route
```

整体上，graph route 已经由代码管理；问题主要集中在 decision 调用内部：同一个 state 条件同时出现在调用前代码、system prompt、input instruction、schema description 和返回后归一化中。

### 2.1 本 PR 的职责边界

本审计驱动的 prompt PR 只调整 decision 的有效提示词组装，不重构 graph：

- static shared contract、node contract 和 structured-output wording 保持在 system/schema。
- 用户请求、任务摘要、候选 capability、announce、workdir/runtime 作为事实注入对应 input。
- input 不再添加与 system policy 重复的 `<instruction>`。
- plan_draft 继续是 taskDecision 的可选参考；prompt 不根据草案存在性表达 route/guard 条件。
- capability subagent 的选择仍由 routeDecision 的语义判断完成，`lane` 只是 schema/graph 的编码字段。

下列“当前职责分布”和“当前问题”章节保留改造前摸排，便于审阅每项变更；它们不是本 PR 合并后的运行时状态。

> 后续修订：entryDecision 不再把主对话压缩进 `user_intent_context`，也不再读取全局
> recent announces。它使用 facts-only system message，加上保留 human/assistant 角色和时间顺序的
> canonical main messages；completed announce 只通过 handoff copy 进入该对话。

## 3. taskDecision（改造前基线）

### 3.1 当前职责分布

调用前代码：

- 从 state 读取用户请求、近期对话、context compaction、recent announces 和 artifacts。
- `hasTaskPlanDraft = runTaskPlanDraft 非空`。
- `canCreateTaskPlanDraft = runDelegationSummaries.length === 0`。
- 根据这两个布尔值选择 system prompt 分支和 input instruction 分支。

当前 system prompt：

- 让模型判断 `answer | next_task`。
- 让模型生成 task、context_summary、search_keywords 和 plan_draft。
- 把 `runDelegationSummaries` 动态内容直接拼进 system。
- 根据 state 生成三套 plan 相关文字：判断重点、判断依据、维护说明、字段语义和 JSON 示例。
- 在多个位置重复“首轮可创建 / 有草案维护 / 无草案不创建”。

当前 input：

- 注入用户请求、近期消息、历史结论和上一轮草案。
- 再根据同一 plan state 写入一条 `<instruction>`，重复 system 中的条件规则。

LLM 返回后代码：

- 再次计算是否允许写 plan_draft：已有草案，或本 run 尚无 delegation summary。
- 不允许时强制把模型返回的 plan_draft 置为 null。
- `action=answer` 时清理 pending task、plan draft 和 search state，并写 `runPendingFinalReply=answer`。
- `action=next_task` 但 task 为空时进入 inline stop。
- 其余情况写 `runPendingTask`，交给 capabilitySearch。

最终 route：

- 有 `runPendingTask` -> capabilitySearch。
- `runPendingFinalReply=answer` -> answer。
- inline -> finalizeRun。

### 3.2 当前问题

- plan 模式在四层重复：调用前布尔值、system prompt、input instruction、返回后 gate。
- 当前实现把“非首轮且没有 plan_draft 就结束”当作确定性控制规则；这不是应当固化的业务事实，而是 plan_draft 从自我引导草稿漂移成控制状态的表现。
- plan 写权限实际上由代码控制，prompt 中大量解释没有增加控制力，只增加冲突面。
- `afterDelegationOutcomeDecision` 又使用 plan_draft 是否非空决定 task_done 后回 taskDecision 还是 answer，使草案事实上成为控制状态，违反“只给模型看的自我引导草稿”原则。
- 动态 `runDelegationSummaries` 位于 system，破坏静态/注入边界。
- 固定 JSON 示例会把 task 和 plan_draft 锚定到某一种业务场景。

### 3.3 目标归属

代码负责：

- 对 answer/next_task 的字段互斥、plan 长度、空 task 做结构校验。
- 保存、再次注入和 run 入口 reset plan_draft，但不解释它的内容，也不根据是否为空分支。
- 把模型结果写入 state，并执行后续 route。

LLM 负责：

- 判断现有上下文是否足以交给 answer，还是还需要一个 delegated task。
- 生成当前单步 task、必要上下文和 capability search 关键词。
- 根据用户目标、当前 task 和委托结论判断是否需要 plan_draft；没有旧草案时也可以创建或保持 null。
- input 已有草案时，把它作为参考，结合最新结论沿用、删除、改写或清空。

prompt 只需要：

- 一个静态 taskDecision 语义契约。
- plan_draft 字段的稳定内容语义。
- 上一轮 plan_draft 作为可选 input data；不再把 state mode 翻译成多套自然语言规则，也不暗示草案决定是否续跑。

## 4. capabilitySearch（改造前基线）

capabilitySearch 当前是纯代码节点，不调用 LLM：

- 没有 `runPendingTask` 时 no-op。
- forced capability guard 可直接种入候选。
- query 使用 `searchKeywords ?? task`。
- `searchCapabilities` 产生 candidates 并写 `runCapabilitySearchState`。

这个职责边界是干净的。需要维持：

- forced capability、搜索是否执行、query fallback 和候选排序都由代码负责。
- taskDecision 只提供搜索语义，不知道 capability 枚举。
- routeDecision 只在候选已经形成之后做语义选择。

## 5. routeDecision（改造前基线）

### 5.1 当前职责分布

调用前代码：

- 解析 general toolkits/tools 和当前 capability registry。
- 从 `runCapabilitySearchState` 读取 candidates、attempted 和 query。
- 没有 `runPendingTask` 时不调用 LLM，直接 inline stop。
- candidates 为空时不调用 LLM，直接选择 `general`。

当前 system prompt：

- 让模型从 custom capability candidates 与 general 中选择执行当前 task 的 capability subagent。
- `targetsContext` 动态拼入 system，包含 general tools、候选列表、search 是否尝试和 general/capability 是否可用。
- 同时写入 custom 优先、general fallback 和缺参时仍选匹配 capability 等规则。

当前 input：

- 注入 current task、context_summary 和 search_keywords。
- 另有 `<instruction>` 重复“只选择执行 capability”。

LLM 返回后代码：

- 解析 `lane` 字段所编码的 capability 选择。
- 验证 custom capability 是否仍存在于 registry。
- general 被选择但没有 general tools 时 inline stop。
- 创建或复用 delegation id，写 active delegation 和 runDelegationSummaries。

### 5.2 当前问题

- capability candidates 和 general availability 是动态 state/config，却被放进 system。
- candidates 为空时代码无条件选择 general；general tools 为空的事实要到返回后才变成 inline stop。
- schema 始终包含 `general`，即使当前 general capability 不可执行。
- “候选为空”“general 不可用”已经能由代码确定，不应该依赖 prompt 描述或模型避免非法选项。
- routeDecision 的业务语义是选择 capability subagent；`lane` 只应是返回值的编码字段。

### 5.3 目标归属

代码负责：

- 验证 pending task 和所有 capability availability。
- 没有 candidate 且 general 可用时直接选择 general。
- 没有任何可用 capability 时直接进入 fallback。
- 构建只包含当前真实可选 capability 的 schema。
- 校验模型选择、创建 delegation、更新 state 和 route。

LLM 负责：

- 在两个或更多真实可用选择之间，判断哪个 capability subagent 最匹配当前 task。
- 判断词面命中的 custom candidate 是否真的覆盖 task 需要。

prompt 只需要：

- 静态的 capability 匹配原则。
- task 和候选 capability 作为 input data。
- 不需要描述候选为空、registry 不可用或 general 不可用等状态分支。

## 6. outcomeDecision（改造前基线）

### 6.1 当前职责分布

调用前代码：

- 从 state 读取 active delegation、当前 announce、completion reason、artifacts 和其他 task summaries。
- handoff guard 根据 completion reason 计算 `canHandoffActiveDelegation`。
- 在允许 handoff 时预构造 handoff messages，并去重已有 copy。
- iteration limit guard 已在进入 outcomeDecision 前执行。

当前 system prompt：

- 让模型输出 `continue | task_done | goal_done`。
- 让模型依据当前 task、announce、用户目标和其他 task 结论做语义验收。
- 重复描述三个 outcome、gap_note、禁止字段和 JSON shape。
- `goal_done` 在 system、output instruction 与 schema description 中存在不同口径。

当前 input：

- 注入用户请求、active task、announce、completion reason、其他 task summaries 和 artifacts。
- active task 或 announce 缺失时写 missing marker，但仍可能调用 LLM。
- `<instruction>` 再次要求模型判断下一步。

LLM 返回后代码：

- 没有 active delegation 时 inline stop。
- `continue`：复用同一 delegation id 和 capability，gap_note 写入下一次 contextSummary。
- `task_done`：handoff、完成当前 task、保留 plan_draft，由后续 route 决定是否回 taskDecision。
- `goal_done`：handoff、完成当前 task、清空 plan_draft、进入 answer。
- handoff 不允许或无法构造时 inline stop。

最终 route：

- continue 生成的 `runNextDelegation` 回到原 capability subagent。
- goal_done 通过 `runPendingFinalReply=answer` 进入 answer。
- task_done 后，plan_draft 非空才回 taskDecision；否则进入 answer。

### 6.2 当前问题

- active delegation/announce 是否存在是代码可判断的前置条件，但当前仍可进入 LLM。
- output 语义同时维护在 system prompt、`buildDelegationOutcomeDecisionOutputInstruction` 和 Zod description，容易漂移。
- graph transition 已由代码决定，prompt 不需要把 state route 当成模型责任反复说明。
- `goal_done` 的“目标完成”与“停止自主执行”口径不一致，会让模型在需要用户澄清时犹豫。
- task_done 后根据 plan_draft 是否非空选择 taskDecision/answer，让 outcomeDecision 已经判断“总目标未完”后仍可能被代码提前结束。

### 6.3 目标归属

代码负责：

- active delegation、announce 和 completion reason 的完整性检查。
- iteration guard、handoff guard 与 handoff message 构造。
- continue/task_done/goal_done 对 state 的确定性写入。
- task_done 后始终回 taskDecision；goal_done 进入 answer。
- plan_draft 的保存与 run reset，但不根据其存在性决定 route。
- output schema、字段合法性和最终 route。

LLM 负责：

- announce 是否形成当前 task 的可接受结果。
- 同一 task 继续执行是否仍能有效推进，还是需要结束当前 task。
- 结合已有结论，用户目标是否仍有明确执行工作，还是应停止执行交给 answer。
- 为 continue/task_done 生成语义 gap_note。

prompt 只需要：

- 三个 verdict 的稳定语义边界。
- 用户目标、task、announce 和其他结论作为 input data。
- 不包含 plan_draft、handoff availability、iteration count 或具体 graph route 条件。

## 7. Final reply 路径

当前实现存在两条用户回复路径：

```text
normal:  runPendingFinalReply='answer' -> answer -> END
inline:  code/guard 写 AIMessage -> runPendingFinalReply='inline' -> finalizeRun -> END
```

inline 路径是明确的职责越界：decision/guard/fallback 代码同时决定停止原因和用户文案，并绕过唯一 answer 节点。它也让固定内部错误文案直接暴露给用户，无法结合完整对话调整语气、解释和下一步。

目标结构：

```text
taskDecision / routeDecision / iteration guard：业务 state -> conditional edge
outcomeDecision：verdict -> Command({ update, goto })
所有正常终态：answer -> END
```

代码负责：

- 保留 answer 所需的业务 state、guard 事实和 handoff 结论。
- 清理执行 transient，并把正常终态路由到 answer。
- 对真正 invariant violation 做校验、抛错或恢复，不把它包装成固定用户文案。
- 不在正常终态路径直接追加用户可见 AIMessage。

answer 负责：

- 结合用户请求、主对话、handoff 结论与已有 state/guard 事实生成唯一用户可见回复。

因此应删除 `runPendingFinalReply` channel/type/reset、`'inline'`、`buildInlineStopResult`、`finalizeRun` 节点和所有 inline route。taskDecision、routeDecision 与 iteration guard 使用 conditional edge；outcomeDecision 因 verdict 同时决定 state update 和下一跳，窄用带有限 `ends` 的 `Command({ update, goto })`。

## 8. 条件归属总表

| 条件或判断 | 当前实现位置 | 目标 owner |
|---|---|---|
| run 是否需要 reset | runStateResetGuard | code |
| context 是否需要 compact | contextCompactionWatermarkGuard | code |
| active task 是否 awaiting decision | afterContextPrep | code |
| run iteration 是否达到上限 | runIterationLimitGuard | code |
| 当前是否还需要执行 | taskDecision LLM | LLM |
| 当前单步 task 内容 | taskDecision LLM | LLM |
| capability search query fallback | capabilitySearch | code |
| forced capability candidates | forcedCapabilitySeedGuard | code |
| candidates 是否为空 | route runner + system context | code |
| general capability 是否可执行 | system context + route result validation | code |
| candidate 与 task 是否语义匹配 | routeDecision LLM | LLM |
| route 输出是否为真实可用 capability | schema + result validation | code |
| active delegation/announce 是否存在 | input missing marker + result validation | code precondition |
| handoff 是否允许 | delegationOutcomeDecisionGuard | code |
| 当前 task 是否达标 | outcomeDecision LLM | LLM |
| 同一 task 是否值得继续 | outcomeDecision LLM | LLM |
| 用户目标是否还有明确执行工作 | outcomeDecision LLM | LLM |
| verdict 对 state 的写入 | buildDelegationOutcomeDecisionResult | code |
| task_done 后是否回 taskDecision | outcomeDecision Command | code 固定回 taskDecision |
| 用户可见终态由谁生成 | answer 或 inline/finalize 两条路径 | 正常终态统一由 answer 生成；不新增 final-reply route state |

## 9. 目标边界

最终希望三个 LLM decision 分别只回答一个语义问题：

```text
taskDecision:
  结合用户目标和已有委托结论，现在是否需要一个新的 task？需要的话，当前一个 task 是什么？

routeDecision:
  当前真实可用的 capability subagent 中，哪个最适合执行这个 task？

outcomeDecision:
  当前 announce 是否足以结束当前 task；接下来应继续同一 task、结束当前 task，还是停止自主执行？
```

任何能写成 `if (state.x ...)`、集合为空检查、枚举合法性、计数上限或 availability 判断的规则，默认归 code。prompt 只保留模型完成上述三个语义判断所需的稳定契约和事实输入。

## 10. 建议迁移顺序

1. 删除 `runPendingFinalReply` 与 inline/finalizeRun 旁路；正常终态统一进入 answer，真正 invariant violation 交给校验或恢复。
2. 删除 plan_draft；task_done 固定回 taskDecision。
3. taskDecision 只根据用户目标、主对话和已完成委托结论生成当前 task。
4. 为三个 runner 增加明确的 code precondition，消除其他不应调用 LLM 的状态。
5. 把 route targets 从 system 移到 input，并让 schema 只暴露真实可用 capability。
6. 统一 outcome schema description 与 system verdict 语义，删除重复 output instruction。
7. 删除三个 input 中的 `<instruction>`，确保 input 只剩事实。
8. 增加 transition 测试：task_done 进入 taskDecision；outcome 三态 Command 与其余 conditional edge 目的地正确；所有正常终态只经过 answer 并只产生一条用户回复。
