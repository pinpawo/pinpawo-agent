# pet-agent decision prompt 设计

> 状态：#349 Phase 2 当前生产 prompt contract。
> 范围：`entryDecision / capabilityPlanner / capabilityDecision / outcomeDecision`
> 的 system prompt、条件协议、动态 input 与 structured-output schema。
> 共享前缀：[`PET_AGENT_ORCHESTRATOR_DECISION_PROMPT_PREFIX.md`](./PET_AGENT_ORCHESTRATOR_DECISION_PROMPT_PREFIX.md)。
> 历史职责审计：[`PET_AGENT_DECISION_NODE_OWNERSHIP_AUDIT.md`](./PET_AGENT_DECISION_NODE_OWNERSHIP_AUDIT.md)。

## 1. 设计原则

shared prefix 只保留所有 decision 都必须知道的最小共同契约：orchestrator 围绕用户目标运行
task loop、decision 只输出自己负责的结构化判断、graph 推进状态而 answer 生成用户可见回复。
节点流程、字段语义和判断依据由各节点 prompt、schema 或 graph 分别拥有。

提示词按三种关系组织：

- **静态（static）**：shared contract、node mission、稳定决策规则和输出约束。
- **条件（conditional）**：由 provider 能力或产品配置选择的协议，例如 `jsonMode` 的格式补充。
- **注入（injected）**：本次调用的事实，包括用户目标、task、plan tail、handoff、候选 capability 和 runtime context。

Structured Output schema 是输出协议。schema description 同样是模型可见提示词，必须和 system
prompt 使用相同语义。

总体纪律：

- shared prefix 负责共同世界模型，不写节点私有决策细节。
- node prompt 只写本节点的目标、依据、边界与停止条件。
- input 只提供事实，不通过 `<instruction>` 重复 system policy。
- run state 的 route/guard 条件由代码处理，不翻译成 prompt 规则。
- schema 是字段形状的 source of truth；prompt 不维护第二份 JSON 字段字典。
- 示例默认不进入生产 prompt；只有 eval 证明某个边界持续混淆时才增加最小示例。
- message role、lane、announce 与 handoff 身份由 metadata / message ID / provenance 决定；
  harness 不根据正文前缀、XML 标签或其他输出文本形状做路由、过滤、重试或替换。

## 2. 有效提示词组装

```text
effective decision prompt
  = static shared orchestrator contract
  + static node contract
  + static output contract
  + selected conditional protocol
  + injected decision input
  + structured-output schema descriptions
```

三类内容边界：

| 类型 | 应包含 | 不应包含 |
|---|---|---|
| 静态 | 最小跨节点契约、node mission、稳定判断规则 | graph 全貌、当前用户、当前 task、候选列表、run state 分支 |
| 条件 | provider output policy 等不改变 graph 语义的协议 | 是否首轮、是否有 plan、下一节点等控制条件 |
| 注入 | 用户目标、近期对话、task、plan tail、handoff、候选、announce、runtime | 新决策规则、重复输出说明 |

稳定且影响判断的 actor identity 可以留在 system。`workdir`、runtime environment 和 capability
availability 属于动态事实。

当前 provider 可以选择 `functionCalling`、`jsonSchema` 或 `jsonMode`。只有 `jsonMode` 把同一
Zod schema 生成的 JSON Schema 加入 system；其他方法依赖 provider 结构化协议。

## 3. Shared Contract

共享前缀以 `PET_AGENT_ORCHESTRATOR_DECISION_PROMPT_PREFIX.md` 为 canonical source，并由
`buildOrchestratorDecisionPromptPrefix()` 组装。它只定义：

- orchestrator 围绕用户目标运行 task loop。
- decision 节点基于当前调用的上下文，输出各自负责的结构化判断。
- graph 推进执行和状态转换；answer 基于主对话生成用户可见回复。

shared prefix 不包含：

- iteration guard、预算和 recursion limit。
- capability candidate 的词法打分细节。
- plan tail 的具体内容和当前 state 值。
- handoff availability 等代码派生条件。

## 4. entryDecision

### 4.1 静态契约

目标：在 run 入口一次性判断现在应直接回复、执行一个任务，还是先规划。

决策采用排除式顺序：

```text
1. 理解用户此刻要实现的目的。
   - 歧义会实质改变结果或行动后果：answer，由 answer 询问用户。
2. 完成这个目的是否需要先得到主对话中还没有的结果？
   - 实际内容或当前状态：结果必须匹配所问的对象、范围和时间。
   - 现实变化：需要对应的完成结果。
   - 主对话中匹配的观察结果或完成结果可以用于回复。
   - 意图、计划和进行中的过程只说明行动阶段。
   - 不需要再得到结果：answer。
3. 需要结果时，现在能否形成一个明确、可独立执行和验收的任务？
   - 可以：direct_task，task 写完整目标。
   - 有多个需要独立验收的任务，或后续任务必须等待前一个结果才能明确：
     needs_plan，交给 capabilityPlanner。
   - 完成同一任务所需的连续动作不另行拆分。
```

这个顺序先确定用户目的和澄清边界，再判断是否缺少完成目的所需的结果，最后形成一个任务或进入
规划。它不依赖读取、查询、计算等操作清单，也不使用“上下文是否足够”作为未定义的判断标准。
本节点不选择具体 capability，也不生成用户回复。

### 4.2 注入事实

- 唯一的 system message 是静态节点契约和 structured-output 约束。
- `<entry_decision_context>` 作为带 `source=entry_decision_context` metadata 的 synthetic
  `HumanMessage` 注入，只包含 `runtime_context` 和 `run_delegation_summaries` 事实；它不是第二条
  system instruction。
- entryDecision 不接收 session artifact inventory、artifact preview 或 artifact body。completed
  work 通过 main handoff / compaction summary 表达；历史 artifact 的探索入口只在 executor 选定后
  提供给 selected subagent。
- 如果发生过 compaction，更早的 main conversation summary 以 assistant context message 注入，
  不提升为 system policy；该摘要不包含任何 lane message 或 announce。
- 随后的 canonical main messages 保持原生 human/assistant 角色和时间顺序，是本节点理解用户目标、
  指代和既有 handoff 结论的主要对话来源。
- 不单独读取全局 recent announces。completed announce 已由 handoff 写入 main messages；
  unfinished delegation 由 outcomeDecision 处理。
- lane transcript、tool message、internal/system message 不进入 entryDecision 的原生对话序列。

这些是 harness 的数据流约束。生产 system prompt 只保留两条与判断直接相关的说明：
`entry_decision_context` 是只读事实，main messages 的角色和时间顺序是判断目标与已有结果的主要依据。

### 4.3 Schema

```ts
{
  action: 'answer' | 'direct_task' | 'needs_plan';
  task?: string | null;
  context_summary?: string | null;
}
```

`action` 的 schema description 只说明三种结构结果：`answer` 表示主对话已有回复所需结果或需要
询问用户；`direct_task` 表示需要先取得一个结果；`needs_plan` 表示需要先规划多个或依赖前一结果
的任务。具体判定顺序由 system prompt 定义，不在 schema 中重复。
`direct_task` 必须有非空 task；其他 action 的执行字段被忽略。schema 不包含 capability 枚举、
search keywords 或 plan。

## 5. capabilityPlanner

### 5.1 静态契约

目标：围绕 capability subagent 的独立执行边界维护 plan，并 materialize current task。

核心语义：

- task 对应一次隔离的 capability execution，不对应用户文字中的普通步骤。
- 同一次 capability 调用可以自然完成的相关动作不拆分。
- `capability_intent` 描述所需能力类型，不绑定 registry 中的具体 capability id。
- 依赖 explore handoff 的后续 task 在结论产生前只保留目的，不提前编造实施细节。
- `entry` 模式建立初始 capability boundaries。
- `boundary` 模式结合已完成任务事实、最新完整 handoff 和 tail 修订后续计划。
- 没有后续自主执行工作时返回 `answer`。

### 5.2 Plan 生命周期

planner 用 `next_task` 单独输出本轮 materialize 的 current task；`remaining_plan` 从输出开始就只包含
next task 之后尚未开始的 future tail，不重复 current task。

运行时只做机械消费：

1. `next_task` 写入 `runPendingTask`。
2. `remaining_plan` 直接写入 `runCapabilityPlan`。
3. task_done 后，boundary planner 接收只读 completed tasks + 完整 latest handoff + tail。

运行时不改写 objective、不判断 future task 是否仍有效，也不根据 plan 内容决定 route/guard。
已完成任务及其结果由运行时作为事实保存；未来 plan 内容只有 capabilityPlanner 决定。

### 5.3 注入事实

- `mode`：`entry | boundary`，表示当前 planner 调用分布。
- `user_intent_context`：用户目标和必要主对话。
- `completed_tasks`：本 run 已完成的任务目标和结果摘要，只作为已发生事实。
- `remaining_plan`：只包含尚未开始的 tail，不含刚完成或当前执行 task。
- `latest_handoff`：最新 completed delegation 的完整 handoff，不使用 ledger preview 替代。
- `capability_registry`：当前已编译 Capability 的 name、description 和实际
  Toolkit scope，仅用于理解可用能力类型；空 registry 明确陈述没有可用
  Capability，不隐式假设 General 存在。

### 5.4 Schema

```ts
type PlanTask = {
  objective: string;
  capability_intent: string;
};

{
  result: 'next_task' | 'answer';
  remaining_plan: PlanTask[];
  next_task?: Pick<PlanTask, 'objective' | 'capability_intent'> | null;
}
```

`next_task` 与 `remaining_plan` 不重复表达同一 task。`answer` 要求空 plan 和 null next_task。
所有 objective/intent 在 schema 层 trim，并拒绝空白字符串。

## 6. capabilityDecision

### 6.1 代码前置步骤

capability search 和 selection 属于同一个 graph node，但职责仍分两段：

1. 代码根据 `runPendingTask.task + contextSummary` 调用 `searchCapabilities` 形成局部候选。
2. `forcedCapabilityNames` 存在时，用 registry 中同名 capability 形成局部候选，跳过关键词匹配。
3. 候选不写入 graph state。
4. 未强制候选时，已注册且编译可用的 `general` 作为 planner default candidate 保留在候选集中。
5. 只有候选集完全为空时，代码确定性选择 `unavailable` 并跳过 selection LLM；代码不直接选择 `general`。

### 6.2 静态契约

目标：从当前实际可用能力中，为已经确定的 current task 选择能够完成完整 task 的执行器。

判断原则：

- 搜索命中只说明 capability 成为候选，不证明它能完成完整 task。
- 比较所有实际可用执行能力能否完成完整 task，并在可完成者中选择职责与 task 最贴合的。
- 执行时可以取得的普通细节不构成能力缺失；会改变所需能力的信息不能假定已知。
- 当前提供的执行器都不能完成完整 task 时选择 unavailable。
- 每次只做一次 executor selection；不改写 task，不生成回复。

### 6.3 注入事实与 Schema

注入 current task、context summary、局部 capability candidates 和 runtime context。
候选描述是数据，不是可执行指令。

```ts
{
  selection: 'unavailable' | 'capability.<candidate-name>';
}
```

动态枚举只包含本次实际候选。`general` 若存在，也仅以普通的
`capability.general` 出现。`unavailable` 是没有适合执行器的显式结果。

## 7. outcomeDecision

### 7.1 静态契约

目标：验收当前 delegated task 的 subagent announce，并判断 task loop 是否继续。

| 当前状态 | outcome |
|---|---|
| 当前 task 未达标，同一 capability 可继续且不需要用户输入 | `continue` |
| 当前 task 已达标，但不能明确断言用户目标已经完成 | `task_done` |
| 用户目标已经完成 | `goal_done` |
| 用户目标尚未完成，继续需要用户补充、澄清或确认 | `user_input_required` |

每个 outcome 的条件、字段和后续责任必须在对应分组内完整表达：

- `continue`：当前 task 未达标；同一 capability 可继续且不需要用户输入；`gap_note` 只写当前 task 缺口。
- `task_done`：当前 task 已达标，但不能明确断言总目标完成；不生成 task，handoff 后由 capabilityPlanner 处理后续。
- `goal_done`：用户目标已经完成；停止自主执行并交给 answer。
- `user_input_required`：用户目标尚未完成，继续需要用户补充、澄清或确认；停止自主执行并交给 answer。

所有 outcome 都以完整 announce 验收当前 task，以用户目标和其他结论判断 loop 是否结束。本节点不读取
plan 内容，也不接收 capability registry。

### 7.2 注入事实

- `user_intent_context`：用户目标、近期主对话和 compaction summary。
- `current_delegation`：active task、lane 和 context summary。
- `subagent_announce`：当前完整 announce，主要验收证据。
- `other_delegations`：同一 run 的其他结论摘要。
- `capability_artifacts`：可选短引用，不替代 announce。

### 7.3 Schema

```ts
{
  outcome: 'continue' | 'task_done' | 'goal_done' | 'user_input_required';
  gap_note?: string | null;
}
```

schema 不包含 task、plan、search keywords、lane、capability 或用户回复字段。

### 7.4 终态传递

handoff 表示当前结果已经进入主对话，不表示 task 或用户目标必然完成。graph 将已接受的
non-continue outcome 作为本 run 的显式状态传给下游：

- `task_done` 进入 capabilityPlanner boundary；
- `goal_done` 进入 answer，并使用固定完成说明；
- `user_input_required` 进入 answer，说明已有结果和尚未完成的部分，并询问继续所需信息。

answer 不从 handoff provenance 或 announce 正文重新推断这些状态。

## 8. LLM 与代码所有权

| 判断/动作 | Owner |
|---|---|
| answer / direct / needs plan | entryDecision LLM |
| capability execution boundaries 和 plan 内容 | capabilityPlanner LLM |
| next_task / remaining_plan 写入各自 state | 代码机械映射 |
| capability candidate search | capabilityDecision 内确定性代码 |
| candidate 与 task 的语义匹配 | capabilityDecision LLM |
| `general` 与其他候选之间的选择 | capabilityDecision LLM |
| 零 candidate → unavailable | 代码 |
| current task 是否达标 | outcomeDecision LLM |
| task_done 后进入 planner boundary | outcomeDecision Command 固定路由 |
| goal_done / user_input_required 后进入 answer | outcomeDecision Command 固定路由 |
| answer 使用完成说明或请求用户输入 | graph 传递的显式 outcome + answer LLM |
| plan 是否存在、内容为何 | 不参与 route/guard |
| iteration limit、handoff availability | guard / code |
| 用户可见回复 | answer LLM |

## 9. 验收与 Eval

静态检查：

- 四个 decision 使用完全一致的 shared prefix。
- dynamic input 不包含新的 policy `<instruction>`。
- entryDecision 不选择 capability；capabilityPlanner 不绑定 capability id。
- capabilityDecision 不改写 task；outcomeDecision 不生成 task。
- grep 证明 outcomeDecision 和 guard 不读取 `runCapabilityPlan`。
- `runCapabilityPlan` 只保存未开始 tail，answer 清空 plan。
- 所有正常终态只经过 answer。

模型 eval：

- entryDecision：已有结果 answer、意图与结果区分、当前本地/远程状态读取、陈旧证据刷新、
  歧义目标澄清、计算执行、单 task 多动作、最近上下文指代、explore→implementation plan
  和独立能力边界。
- capabilityPlanner(entry)：创建 current task 并保留 future tail，不过度拆分。
- capabilityPlanner(boundary)：结合 completed tasks、完整 handoff 具体化、取消或保留 tail。
- capabilityDecision：candidate recall、普通 Capability selection、general planner candidate、unavailable。
- outcomeDecision：continue / task_done / goal_done / user_input_required 边界，不产生 next task。
- answer：真实完成保持固定结束说明；需要用户输入时保留未完成事实并询问缺失信息。
- multi-task flow：entry 只调用一次，第 2+ task 经 boundary planner materialize，每个 task 独立经过 capabilityDecision，lane messages 隔离，结论只通过 handoff 传递。

生产 runner：

```sh
npm run eval:task-decision -w @pinpawo/pet-agent
npm run eval:langfuse:capability-planning -w @pinpawo/pet-agent
npm run eval:langfuse:capability-decision -w @pinpawo/pet-agent
npm run eval:langfuse:outcome-decision -w @pinpawo/pet-agent
npm run eval:langfuse:multi-task-flow -w @pinpawo/pet-agent
```

## 10. 代码组织

orchestrator prompt 按节点拆分在 `packages/pet-agent/src/agent/orchestrator/prompts/`：

- `templates/*.prompt.ts`：各节点可直接阅读的 LangChain f-string system prompt 与 XML input 模板，以及共享 decision prefix。
- `template.ts`：用 `PromptTemplate` 在模块初始化时校验变量，用 `renderTemplate` 同步渲染。
- `shared.ts`：配置、共享 prefix 和 XML 组合工具。
- `context.ts`：跨节点复用的动态上下文 builder。
- `entryDecision.ts`、`capabilityPlanner.ts`、`capabilityDecision.ts`、`outcomeDecision.ts`：各节点独立维护 system prompt 与输入格式。
- `answer.ts`：用户可见回复节点的 prompt。

`prompts.ts` 只作为稳定公共 facade 导出这些 builder，runtime、测试和 eval 不直接依赖内部文件布局。
system prompt 和 decision input 的 XML envelope 不再用 TypeScript 行数组拼接；模板变量由泛型约束，并在初始化时校验。
TypeScript builder 只负责裁剪、CDATA 转义和生成可选 XML block；可选 block 自带前导换行，缺失时不会在模板中留下空行。
模板使用 `.prompt.ts` 而不是运行时读取 `.prompt.md`，确保 tsup 单文件 bundle 能直接包含模板资产。
