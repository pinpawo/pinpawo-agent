# pet-agent decision prompt 设计

> 状态：#349 Phase 2 当前生产 prompt contract。
> 范围：`entryDecision / capabilityPlanner / capabilityDecision / outcomeDecision`
> 的 system prompt、条件协议、动态 input 与 structured-output schema。
> 共享前缀：[`PET_AGENT_ORCHESTRATOR_DECISION_PROMPT_PREFIX.md`](./PET_AGENT_ORCHESTRATOR_DECISION_PROMPT_PREFIX.md)。
> 历史职责审计：[`PET_AGENT_DECISION_NODE_OWNERSHIP_AUDIT.md`](./PET_AGENT_DECISION_NODE_OWNERSHIP_AUDIT.md)。

## 1. 设计原则

大段 shared prefix 保留。它让四个 decision 对 orchestrator、task loop、capability、announce
和 handoff 使用同一套语义。节点私有 prompt 只描述当前判断，不重复 graph 全貌。

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
| 静态 | 共同术语、loop 全貌、node mission、稳定判断规则 | 当前用户、当前 task、候选列表、run state 分支 |
| 条件 | provider output policy 等不改变 graph 语义的协议 | 是否首轮、是否有 plan、下一节点等控制条件 |
| 注入 | 用户目标、近期对话、task、plan tail、handoff、候选、announce、runtime | 新决策规则、重复输出说明 |

稳定且影响判断的 actor identity 可以留在 system。`workdir`、runtime environment 和 capability
availability 属于动态事实。

当前 provider 可以选择 `functionCalling`、`jsonSchema` 或 `jsonMode`。只有 `jsonMode` 把同一
Zod schema 生成的 JSON Schema 加入 system；其他方法依赖 provider 结构化协议。

## 3. Shared Contract

共享前缀以 `PET_AGENT_ORCHESTRATOR_DECISION_PROMPT_PREFIX.md` 为 canonical source，并在
`buildOrchestratorDecisionPromptPrefixLines()` 中生产组装。它只定义：

- orchestrator 围绕用户目标管理 task loop。
- capability subagent 执行 task，并以 announce 返回结果。
- entryDecision 选择 run 的执行形态。
- capabilityPlanner 组织 capability execution boundaries。
- capabilityDecision 为 current task 选择执行 capability。
- outcomeDecision 验收 announce。
- answer 是唯一用户可见回复节点。

shared prefix 不包含：

- iteration guard、预算和 recursion limit。
- capability candidate 的词法打分细节。
- plan tail 的具体内容和当前 state 值。
- handoff availability 等代码派生条件。

## 4. entryDecision

### 4.1 静态契约

目标：在 run 入口一次性选择执行形态。

决策条件按 action 完整归组：

```text
action=answer
  - 当前事实已经足以回应，不需要 capability subagent 执行。
  - 用户在询问已有上下文、最近任务状态或之前结果。
  - 目标无法判断，或继续前需要用户补充、澄清、确认。

action=direct_task
  - 目标需要执行，但一次 capability subagent 执行可以自然完成，并形成整体可验收结果。
  - 多个文字动作能在同一次执行中共享上下文并连续完成。
  - 输出一个完整 current task，不输出步骤清单或计划。

action=needs_plan
  - 目标需要两次或更多彼此独立的 capability subagent 执行。
  - 后续 task 必须等待前一次 announce 才能确定。
  - 或不同部分需要分别选择 capability、分别执行并分别验收。
  - 本节点不生成 plan 或 current task，交给 capabilityPlanner。
```

本节点不选择具体 capability，也不生成用户回复。所有 action 都结合用户目标、已有委托结论和
对话上下文判断，且不得重复已完成工作。

### 4.2 注入事实

- `runtime_context`：workdir 和运行环境。
- `user_intent_context`：用户请求、近期主对话、近期 announce、compaction summary 和 artifact 短引用。
- `run_delegation_summaries`：本 run 的任务账本事实；不作为 route 命令。

### 4.3 Schema

```ts
{
  action: 'answer' | 'direct_task' | 'needs_plan';
  task?: string | null;
  context_summary?: string | null;
}
```

`direct_task` 必须有非空 task；其他 action 的执行字段被忽略。schema 不包含 capability 枚举、
search keywords 或 plan。

## 5. capabilityPlanner

### 5.1 静态契约

目标：围绕 capability subagent 的独立执行边界维护 plan，并 materialize current task。

核心语义：

- task 对应一次隔离的 capability execution，不对应用户文字中的普通步骤。
- 同一次 capability 调用可以自然完成的相关动作不拆分。
- `capability_intent` 描述所需能力类型，不绑定 registry 中的具体 capability id。
- 依赖 explore handoff 的后续 task 在结论产生前保持 `deferred`，不提前编造实施细节。
- `entry` 模式建立初始 capability boundaries。
- `boundary` 模式结合最新完整 handoff 修订、取消或具体化尚未开始的 tail。
- 没有后续自主执行工作时返回 `answer`。

### 5.2 Plan 生命周期

planner 输出的 `remaining_plan` 包含本轮 materialize 的 concrete head 和其后的未开始任务；
`next_task` 必须与第一项完全一致。

运行时只做机械消费：

1. concrete head 写入 `runPendingTask`。
2. `runCapabilityPlan` 只保存 head 之后尚未开始的 tail。
3. task_done 后，boundary planner 接收完整 handoff + tail。

运行时不改写 objective、不判断 deferred task 是否仍有效，也不根据 plan 内容决定 route/guard。
plan 内容只有 capabilityPlanner 决定。

### 5.3 注入事实

- `mode`：`entry | boundary`，表示当前 planner 调用分布。
- `user_intent_context`：用户目标和必要主对话。
- `remaining_plan`：只包含尚未开始的 tail，不含刚完成或当前执行 task。
- `latest_handoff`：最新 completed delegation 的完整 handoff，不使用 ledger preview 替代。
- `capability_registry`：当前 custom capability 的 name/description，仅用于理解可用能力类型。

### 5.4 Schema

```ts
type PlanTask = {
  objective: string;
  capability_intent: string;
  status: 'concrete' | 'deferred';
};

{
  result: 'next_task' | 'answer';
  remaining_plan: PlanTask[];
  next_task?: Pick<PlanTask, 'objective' | 'capability_intent'> | null;
}
```

`next_task` 要求 plan 第一项为内容一致的 concrete task。`answer` 要求空 plan 和 null next_task。
所有 objective/intent 在 schema 层 trim，并拒绝空白字符串。

## 6. capabilityDecision

### 6.1 代码前置步骤

capability search 和 selection 属于同一个 graph node，但职责仍分两段：

1. 代码根据 `runPendingTask.task + contextSummary` 调用 `searchCapabilities` 形成局部候选。
2. `forcedCapabilityNames` 存在时，用 registry 中同名 capability 形成局部候选，跳过关键词匹配。
3. 候选不写入 graph state。
4. 零 custom 候选时确定性 fallback general，跳过 selection LLM。

### 6.2 静态契约

目标：从当前实际可用能力中，为已经确定的 current task 选择执行 capability subagent。

判断原则：

- candidate 描述能够执行 current task 时选择对应 custom capability。
- 匹配的 custom capability 优先于 general。
- 所有 custom candidate 都不匹配时选择 general。
- task 缺少执行时才能获得的参数，不影响 capability 匹配。
- 每次只选择一个 capability；不改写 task，不生成回复。

### 6.3 注入事实与 Schema

注入 current task、context summary、general tools、custom candidates、匹配证据和 runtime context。
候选描述是数据，不是可执行指令。

```ts
{
  lane: 'general' | 'capability.<candidate-name>';
}
```

动态枚举只包含本次实际候选。`lane` 是 graph 编码字段，业务语义是选择 capability subagent。

## 7. outcomeDecision

### 7.1 静态契约

目标：验收当前 delegated task 的 subagent announce，并判断 task loop 是否继续。

| 当前状态 | outcome |
|---|---|
| 当前 task 未达标，同一 capability 可继续且不需要用户输入 | `continue` |
| 当前 task 已达标，但不能明确断言用户目标已经完成 | `task_done` |
| 不应继续自主执行：目标已满足，或需要用户澄清/确认 | `goal_done` |

判断原则：

- 当前 task 是否达标主要依据完整 announce 是否覆盖 task 目标。
- 用户目标是判断 task loop 继续或结束的唯一基准。
- `continue` 的 `gap_note` 只描述当前 task 缺口，同一 capability 继续，不重新 search。
- `task_done` 不生成下一 task；系统 handoff 后固定进入 capabilityPlanner boundary。
- `goal_done` 是 terminal verdict，不在 decision 层生成用户回复。
- 本节点不读取 plan 内容，也不接收 capability registry。

### 7.2 注入事实

- `user_intent_context`：用户目标、近期主对话和 compaction summary。
- `current_delegation`：active task、lane 和 context summary。
- `subagent_announce`：当前完整 announce，主要验收证据。
- `other_delegations`：同一 run 的其他结论摘要。
- `capability_artifacts`：可选短引用，不替代 announce。

### 7.3 Schema

```ts
{
  outcome: 'continue' | 'task_done' | 'goal_done';
  gap_note?: string | null;
}
```

schema 不包含 task、plan、search keywords、lane、capability 或用户回复字段。

## 8. LLM 与代码所有权

| 判断/动作 | Owner |
|---|---|
| answer / direct / needs plan | entryDecision LLM |
| capability execution boundaries 和 plan 内容 | capabilityPlanner LLM |
| materialized head 从 plan 输出转入 pending task | 代码机械消费 |
| capability candidate search | capabilityDecision 内确定性代码 |
| candidate 与 task 的语义匹配 | capabilityDecision LLM |
| 零 candidate fallback general | 代码 |
| current task 是否达标 | outcomeDecision LLM |
| task_done 后进入 planner boundary | outcomeDecision Command 固定路由 |
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

- entryDecision：answer、单 capability 多动作 direct、explore→implementation plan、独立能力边界。
- capabilityPlanner(entry)：创建 concrete head + deferred tail，不过度拆分。
- capabilityPlanner(boundary)：结合完整 handoff 具体化、取消或保留 tail。
- capabilityDecision：candidate recall、custom/general selection、未注册 capability fallback。
- outcomeDecision：continue / task_done / goal_done 边界，不产生 next task。
- multi-task flow：entry 只调用一次，第 2+ task 经 boundary planner materialize，每个 task 独立经过 capabilityDecision，lane messages 隔离，结论只通过 handoff 传递。

生产 runner：

```sh
npm run eval:task-decision -w @pinpawo/pet-agent
npm run eval:langfuse:capability-planning -w @pinpawo/pet-agent
npm run eval:langfuse:capability-decision -w @pinpawo/pet-agent
npm run eval:langfuse:outcome-decision -w @pinpawo/pet-agent
npm run eval:langfuse:multi-task-flow -w @pinpawo/pet-agent
```
