# refactor(orchestrator): merge outcome decisions into a trace-scoped Planner lane

> 后续的 fresh-run 入口路由设计见
> [`Entry Answer routing draft`](entry-answer-routing.md)。

建议 labels：`architecture`、`orchestrator`、`planner`、`breaking-change`

## 背景

当前 orchestrator 在一次 Capability delegation 返回后，先调用
`delegationOutcomeDecision` 判断：

- 当前 delegation 是否应继续；
- 当前 task 是否已经完成；
- 用户目标是否已经完成；
- 是否必须等待用户输入。

当 verdict 为 `task_done` 时，graph 接受当前 announce，再调用 boundary
Capability Planner 更新剩余计划。这样在一个执行边界上存在两个连续的语义决策：

```text
capability
  -> outcomeDecision
  -> boundary Planner
  -> capability / answer
```

两者都需要理解用户目标、当前 task、最新结果和剩余计划，并都会判断最新结果如何
改变后续工作。独立 Outcome 判断保留了清晰的验收边界，但也造成了以下问题：

1. `task_done` 路径需要连续执行 Outcome 和 Planner 两次模型决策；
2. “目标是否完成”和“是否还有值得执行的计划”被拆给两个 owner，容易出现语义重叠；
3. 当前 Planner 每次 boundary 都重新创建 agent，只能从公开 briefing 重建上下文；
4. Planner 之前读取过的 Capability 文档、搜索观察、规划取舍和计划演化不会跨 boundary 保留；
5. Planner 的现有 `return_to_answer` 可以把自由文本 `reason/context/question`
   带回 root，与 Planner lane 边界不一致。

我们希望保留 Outcome 所代表的执行验收语义，但删除独立的 Outcome 模型节点，将其
并入一个在完整用户任务中持续存在的 Planner actor。

## 决策摘要

将 Capability Planner 重构为一个 **trace-scoped persistent Planner lane**：

- 一个用户任务/目标对应一个稳定的 `traceId`；
- 每次执行、唤醒或恢复拥有独立的 `runId`；
- Planner transcript 作为 root `messages` 中的 `orchestrator` lane，以
  `threadId + traceId` 为持久化边界；
- Planner 在同一 trace 的多个 run、delegation 和用户输入中断之间保持上下文；
- Planner 接管执行边界的验收与后续规划；
- root graph 继续独占 handoff、delegation 生命周期、路由和公开状态更新；
- Planner 对 root 只提交结构化 control action、plan tasks，以及
  `user_input_required` 专用的单个结构化问题；
- Planner transcript、工具消息、Capability 文档观察和内部摘要进入 root checkpoint
  的 Planner lane，但不进入 main conversation、Answer input 或 handoff。
- Capability 渐进披露是 trace-scoped 状态：`general`（若存在）作为第一项，Entry
  搜索命中的 Capability 追加后在后续 Boundary 中继续可见，Boundary 新命中的项也继续追加；
- Planner system prompt 只描述稳定目标与上下文语义；Capability 文档和搜索状态不再拼入
  system prompt。

目标流程：

```text
entryDecision
  -> Planner
       |-- execute_plan        -> capability
       |-- user_input_required -> answer
       `-- unavailable         -> answer
capability
  -> Planner
       |-- continue_current  -> same capability delegation
       |-- advance_plan      -> accept handoff -> next delegation
       |-- goal_done         -> accept handoff -> answer
       |-- user_input_required -> preserve active delegation -> answer
       `-- unavailable       -> preserve truthful blocked state -> answer
```

## 术语与身份边界

本重构必须明确以下四层身份，不得互相替代：

| 标识 | 生命周期 | 用途 |
|---|---|---|
| `threadId` | 整个会话 | 对话与 checkpoint 顶层隔离 |
| `traceId` | 一次用户任务/目标，跨中断与恢复 | Planner lane 和完整任务链路 |
| `runId` | 一次已经开始的 root graph run | 运行时 guard、遥测和单次执行边界 |
| `delegationId` | 一个具体 Capability task | Capability lane、transcript 和执行结果归属 |

关系不是简单的 `run -> delegation` 树：一个 delegation 可能在新的 run 中继续执行，
但仍然属于同一个 trace。

```text
threadId
  `-- traceId
       |-- Planner lane
       |-- runId A
       |-- runId B (resume)
       |-- delegationId D1
       `-- delegationId D2 (may span A and B)
```

当前 `taskActiveDelegation.id` 的实际语义是 `delegationId`，不是本设计中的
`traceId`。实现时应优先把内部变量和新接口命名为 `delegationId`，避免继续扩大
`taskId` 歧义。

## 目标

1. 删除独立的 `delegationOutcomeDecision` 模型调用和 graph node；
2. 由一个持久 Planner 同时判断当前结果是否达标以及下一步计划；
3. 同一 `traceId` 下跨 `runId` 从 root messages 恢复 Planner lane；
4. 同一 delegation 继续执行时保留其 ID、lane 和 transcript；
5. 用现有 lane 协议把 Planner 内部消息与 main conversation、Capability lane 隔离；
6. Planner 向 root 提交 control action、plan tasks 和标准 message reducer updates；
7. 保持 graph 对状态转移、handoff、guard 和用户可见回复的最终所有权；
8. 支持幂等重试、进程重启和 trace 隔离；
9. 保持或提升现有 lifecycle eval 的真实性与稳定性；
10. 减少 accepted non-terminal boundary 上重复的独立模型决策。

## 非目标

- 不把 Planner transcript 合并进 `OrchestratorState.messages`；
- 不让 Planner 直接生成用户可见回复；
- 不让 Planner 直接修改 root state 或执行 handoff；
- 不让 capability agent 自行决定 task 或用户目标是否完成；
- 不依赖 `completionReason` 推导 task 成败；
- 不改变 Capability 文档的公开格式或 registry backend；
- 不在本 issue 中修改 `../../wiki` 或执行 wiki ingest；
- 不在目标结束时立即删除当前 Planner lane；下一条新 trace 的 Planner commit 清理旧 lane。

## 核心不变量

### 1. Planner 是 trace-scoped，而不是 run-scoped

- 新用户任务创建新 `traceId`；
- 对尚未结束的 graph interrupt 执行原生 checkpoint resume 时，保持原 `runId` 和
  `traceId`，从中断位置继续；
- 前一个 run 已经结束、用户在新请求中通过 `resume_active` 继续同一任务时，创建新
  `runId`，但保持 `traceId`；
- 同一 trace 内的所有 Planner invocation 读取同一个 Planner lane；
- `supersede_active` 或明确的新目标创建新 `traceId`；
- 新 trace 不得读取旧 trace 的 Planner state。

### 2. Planner 状态是隔离的 root lane

以下内容只能存在于 root `messages` 的 Planner lane：

- Planner human/AI/tool messages；
- `capability_search` ToolMessage 与当时的文档披露结果；
- 规划过程、被拒绝的候选计划和内部推理；
- terminal ToolMessage 及其 `plannerInputId`；
- registry digest metadata。

这些内容不得进入：

- main message lane；
- Capability delegation announce；
- Answer prompt；
- main-conversation compaction input；
- 面向调用方的投影或 API response；
- `runDelegationSummaries.resultPreview`。

### 3. Planner 只有一个受控输出出口

Planner 只提交 `PlannerCommit`。除 plan task 外，不允许输出任意语义文本。

```ts
type PlannerAction =
  | 'continue_current'
  | 'execute_plan'
  | 'advance_plan'
  | 'goal_done'
  | 'user_input_required'
  | 'unavailable';

type PlannerCommit = {
  action: PlannerAction;
  tasks: CapabilityPlanTask[];
  userInputRequest?: {
    question: string;
  };
};
```

`action` 是 graph control protocol，不是用户内容。可执行语义只通过 `tasks`
投影；`continue_current` 不携带新语义，也不能替换当前 task 或后续计划。
`userInputRequest` 是唯一例外：它只允许在 `user_input_required` 中出现，
且只携带 Answer 必须询问的一个具体问题，不携带推理或上下文。

移除以下 Planner 输出形式：

- `reason`；
- `context`；
- 顶层或自由形式的 `question`；
- `gap_note`；
- direct text fallback；
- Planner 生成的 Answer briefing。

### 4. Root graph 独占状态转移

Planner 只做语义判断并提交 commit。graph 必须确定性地负责：

- 当前 announce 是否写入 main handoff；
- 是否清理或保留 lane；
- delegation status 如何更新；
- 是否复用当前 delegation；
- 如何 materialize 下一项 task；
- terminal reply mode；
- iteration、handoff availability 和 execution limits；
- invariant violation、checkpoint 缺失与恢复失败。

## Planner commit 契约

### `continue_current`

适用条件：当前 task 尚未达标，并且当前 Capability 可以继续补齐。

约束：

- 必须存在 active delegation；
- `tasks` 必须为空；
- graph 保留现有 `delegationId`、lane 和 transcript；
- graph 保留 active delegation task 和此前 committed future plan，不接受 Planner
  在 continuation 中重写它们；
- continuation 不注入 Planner 生成的 gap；subagent 继续读取同一 task 和完整 lane
  transcript；
- 当前 announce 不做 accepted handoff；
- 不把 Planner 的拒绝理由作为独立文本带出。

### `execute_plan`

适用条件：entry 阶段已有可执行的初始计划。

约束：

- `tasks.length >= 1`；
- graph materialize `tasks[0]`，其余 tasks 写入公开 committed plan；
- Planner 不得直接创建 delegation 或写 root messages。

### `advance_plan`

适用条件：Boundary 阶段当前 task 已被最新结果满足，用户目标仍有可以自主执行的工作。

约束：

- `tasks.length >= 1`；
- graph 必须先接受当前 announce、构造 handoff 并完成当前 delegation；
- graph materialize `tasks[0]`，其余 tasks 写入公开 committed plan；
- 默认保持此前 committed remaining plan 不变；accepted handoff 已直接提供给后续执行方，不因新增细节或措辞优化而重写 task；
- 只有最新 accepted result 证明原计划已不再必要、不可执行，或不足以正确覆盖用户目标时才允许修改；必要修改只涉及受影响的最少 tasks，未受影响的 tail 原样保留；
- 下一项 task 可以选择不同的 Capability；
- Planner 不得用它掩盖当前 task 的缺口。

### `goal_done`

适用条件：当前结果与已有公开事实已经完成用户目标。

约束：

- post-execution 阶段必须存在可接受的 announce；
- `tasks` 必须为空；
- graph 接受 handoff、完成 delegation，并以 `goal_done` 进入 Answer；
- Planner lane 文本不能用于完成总结；Answer 只能基于公开请求、accepted handoff
  和 artifact 生成回复。

### `user_input_required`

适用条件：目标尚未完成，并且下一次进展必须先等待用户补充、选择或确认。

该 action 在 Entry 和 execution Boundary 都合法。Entry Answer 仍负责显而易见的
交互分流；如果 Planner 在形成执行计划时才确认存在真正的用户独占阻塞，
也可以在没有 active delegation 时返回 `user_input_required`。

“Planner 尚未核验或不知道某个事实”不属于该条件。只要任一 Capability 能读取、
查询、验证或执行得到所需事实，Planner 必须继续形成可执行 task；用户要求先分析、
评估或给出建议再确认时，也必须先执行仍可自主完成的前置工作。只有用户是缺失信息、
选择或授权的唯一来源，且不存在可先推进的自主工作时，才允许进入该结果。

约束：

- `tasks` 必须为空；
- `userInputRequest.question` 必须是非空、有长度上限的单一具体问题；
- post-execution 阶段保留 active delegation 与 transcript；
- 不把未完成 announce 标记为 completed handoff；
- Answer 原样使用结构化问题，并可根据公开用户请求、当前 announce
  和 artifact 简要说明进展；
- Planner 不输出自由文本 question 或 context；
- 用户回复后，以相同 `traceId`、新 `runId` 恢复 Planner 和 active delegation。

### `unavailable`

适用条件：当前没有可执行 Capability，或 Planner 无法形成合法执行计划。

约束：

- `tasks` 必须为空；
- root 保存 typed blocked state，不接收 Planner 自由文本解释；
- Answer 只根据 registry/runtime 的公开确定性事实说明限制；
- 不能把“没有 Capability”表述为用户目标已经完成。

### 结构校验

schema 和 runtime 必须同时验证：

```text
continue_current     -> active delegation + empty tasks
execute_plan         -> entry + non-empty tasks
advance_plan         -> boundary + non-empty tasks
goal_done            -> empty tasks + accepted-result preconditions
user_input_required  -> entry or boundary + empty tasks + structured question
unavailable          -> empty tasks
```

模型非法输出必须作为 Planner invocation failure 处理，不能通过松散 normalize 把一个
action 静默改写成另一个 action。

## Planner 输入与 lane 协议

每次 Planner 正常开始一个新决策 turn 时，Root 提供当前 canonical messages，Planner
领域按 boundary 选择本次所需的完整只读消息。Planner transcript 已经是 canonical root
messages 中的一个 lane，不需要第二套 checkpoint 或 Planner 专属 resume command。

```ts
type PlannerInput = {
  inputId: string;
  traceId: string;
  runId: string;
  userRequest: UserRequest;
  messages: readonly BaseMessage[];
  activeDelegation: PlannerDelegationInput | null;
  latestAnnounce: {
    messageId: string | null;
    completionReason: SubagentCompletionReason | null;
  } | null;
  remainingPlan: CapabilityPlanTask[];
  capabilityDisclosure: CapabilityDisclosureState;
  registryDigest: string;
};

type CapabilityDisclosureState = {
  registryDigest: string;
  disclosedCapabilityNames: string[];
  emptySearchRounds: number;
  maxEmptySearchRounds: number;
  status: 'open' | 'closed';
};
```

字段是否存在表达当前 boundary：

- 初次规划：没有 active delegation 和 announce；
- 初次规划从完整 root messages 中选择截止当前请求的 main conversation 和当前 trace 的
  Planner lane；
- delegation 返回或 fresh-turn continuation 时选择 main conversation、当前 delegation 的
  完整 tool-protocol-safe lane transcript，以及当前 trace 的 Planner lane；
- announce 字段只保留 boundary identity 与 stop reason；announce 内容、用户追问和执行
  进展直接从原始消息读取，不再重复投影为字符串字段；
- `capabilityDisclosure` 是当前 trace 已经披露给 Planner 的有序 Capability 集合和空搜索
  额度；Entry 与 Boundary 使用同一个状态，而不是每次 invocation 重新创建默认候选；
- registry 变化：在下一次正常 Planner input 中提供新的 digest。

`messages` 是 root checkpoint 已经持久化的 canonical 输入。Planner 领域根据 mode 选择
main conversation、当前 delegation lane 与 Planner lane，保留原始 message objects、媒体
content blocks 和 tool call/result 配对。Planner 本轮产生的新输入、搜索观察和 terminal
tool 配对会标记为 `lane: orchestrator`、`source: capability_planner` 并通过 root message
reducer 回写；它们不会进入 main conversation 或 Capability transcript。

这里的“用户继续”只是 Planner 已完成上一轮 commit 后收到的一个新输入 turn，不是
checkpoint resume，也不需要 `user_resumed` 事件。Capability announce 本来属于 execution
evidence；Planner 只消费它，不拥有它。

## 持久化与恢复设计

Planner 不维护独立 checkpoint namespace。成功调用产生的 lane updates 与 root transition
在同一个 graph step 中提交，因此进程重启后从 root checkpoint 恢复。相同 `inputId` 的
terminal ToolMessage 保存在 Planner lane 中，可直接 replay commit 而不重复调用模型。
fresh trace 在 Entry capture 阶段删除旧 trace 的 Planner lane，即使本轮随后直接 Answer、
不进入 Planner，也不会让隐藏 transcript 无限累积。

Planner 当前只使用无需人机中断的 registry search 和 terminal tools。若未来需要在 Planner
内部支持 `interrupt()`，应把 Planner agent 作为真正的 LangGraph subgraph 接入 parent
checkpoint lineage；不得为此恢复第二套私有 message checkpoint。

#### Fresh-turn task continuation

当 Planner 已经提交 `user_input_required`，Answer 已回复用户，前一个 root run 已正常
结束，之后用户通过新请求继续同一任务时：

- 这是一个新的 root run，因此创建新 `runId`；
- 仍属于同一用户任务，因此保持 `traceId`；
- Planner 读取同一 trace 的 Planner lane；
- root 追加一个包含最新用户消息和 active delegation 的普通 `PlannerInput`；
- Planner 从新的 decision turn 开始，而不是恢复已经结束的旧程序计数器。

这是同一持久 actor 收到下一条输入，不应伪装成 LangGraph interrupt resume。

### Capability 渐进披露状态

Capability discovery 是 trace-scoped、单调增长的披露状态，不是 system prompt 的动态片段，
也不是通过扫描 Planner message 历史重新推导的计数器。

若 effective workspace 包含 `general`，新 trace 初始化为：

```ts
{
  registryDigest,
  disclosedCapabilityNames: ['general'],
  emptySearchRounds: 0,
  maxEmptySearchRounds: capabilityPlannerMaxSearchRounds,
  status: 'open',
}
```

若 workspace 不包含 `general`，初始列表为空。`general` 只是第一项已披露 Capability，
不再具有独立的 `defaultCapability` prompt 契约。模型仍根据完整 Capability 文档的正向职责
选择最贴合当前 task 的执行方；列表顺序不表达优先级。

`capability_search` 命中后，将经过 workspace 验证的 Capability name 按首次发现顺序追加到
`disclosedCapabilityNames`。状态只保存名称和 registry digest；每次 Planner invocation 从当前
workspace 重新解析这些名称并投影完整文档，避免把 Capability 文档正文复制进 checkpoint。
同一名称不得重复追加。

Entry 提交初始计划不会清空披露状态。之后每个 Boundary 继续读取相同的
`disclosedCapabilityNames`；若最新执行结果揭示计划外工作，Boundary 仍可调用
`capability_search` 并追加新 Capability。

搜索额度同样跨 Entry 和 Boundary 保留：

- 同一模型回复中的并行搜索构成一个搜索轮次；
- 任一并行调用命中时，该轮不增加 `emptySearchRounds`；
- 整轮均未命中时增加一次；
- 达到 `maxEmptySearchRounds` 后将 `status` 设为 `closed`；
- search tool 始终保持 `tool_choice=auto` 且继续可调用；closed 后每次调用都返回稳定的
  `capability_search_round_limit_exceeded`，不再披露文档。

closed 表示停止 discovery，不表示 `planner_incomplete`，也不直接决定 root route。Planner
必须基于已披露 Capability 和 Boundary evidence 提交一个终态：可以继续当前任务时
`continue_current`，有后续计划时 `execute_plan/advance_plan`，目标完成时 `goal_done`，
只有确实没有可执行 Capability 时才 `unavailable`。

### 模型可见 Capability context

每次 Entry 和 Boundary invocation 都把当前披露集合投影到本轮 Planner Human input，位于
`run_user_request` 和 planning boundary facts 之前或相邻位置：

```xml
<capability_context source="planner_state" trust="read_only">
  <capability name="general"><![CDATA[完整 CAPABILITY.md]]></capability>
  <capability name="explore"><![CDATA[完整 CAPABILITY.md]]></capability>
</capability_context>
```

该 block 是 runtime state 的只读投影，不是 canonical message，也不写入 main conversation。
Planner system prompt 不包含 `<default_capability>`、已用轮次或剩余轮次。搜索状态只由
`capability_search` 的 ToolMessage 在模型实际搜索时披露；Boundary 不因进入新 invocation
而重置额度。

### 持久化作用域

Planner 使用 root 已配置的持久化 backend 和相同 `thread_id`。`traceId` 写入 Planner
message metadata，作为 lane 的生命周期身份；调用方不管理 Planner thread、session 或
checkpoint namespace。Planner agent 在 orchestrator 构建时创建一次，但每次 invocation
从 root messages 重新选择上下文并以 stateless adapter 运行。

单个 Planner agent invocation 内，`capability_search` 仍通过 `ToolRuntime.state` 读取本轮搜索
observations，并以 `Command.update` 合并并行调用；invocation 结束时，runner 将新增披露名称和
空搜索轮次回写 trace-scoped `CapabilityDisclosureState`。middleware 不扫描 message 历史，也不
拥有披露状态。ToolMessage 只报告本次结果、更新后的额度与稳定的 discovery 状态，不替 root
生成 fallback commit，也不提供另一份 action 决策树。

### 幂等输入消费

Planner terminal ToolMessage 携带 `plannerInputId`，其内容就是经过校验的 commit。建议 input ID：

```text
trace_started:<traceId>
announce:<delegationId>:<announceMessageId>
human:<humanMessageId>
```

registry digest 写入 Planner message metadata，不需要单独模拟成 resume/event。重复 input
从当前 trace、当前 digest 的 terminal ToolMessage replay 同一 commit，不得再次调用模型
或重复追加 Planner messages。

### Root transition 一致性

Planner lane updates 与对应的 root transition 由同一个 node `Command` 提交，不存在 detached
Planner commit 已落盘而 root transition 尚未落盘的双 checkpoint 窗口。graph 重试相同
`inputId` 时，已落盘的 terminal ToolMessage 提供幂等 replay。

### Registry 变化

持久上下文可能包含过期 Capability 文档观察。Planner lane messages 必须记录
`registryDigest`。digest 变化时：

- 不选择旧 digest 的 Planner lane，Capability availability 和文档观察重新验证；
- 重新 materialize workspace；
- 成功提交当前调用时删除旧 digest 的 Planner lane messages；
- 不允许仅凭旧 transcript 选择已经删除或不可用的 Capability。

## Root state 调整

新增或明确：

```ts
type OrchestratorTraceState = {
  traceId: string;
  runId: string;
  plannerInitialized: boolean;
  runCapabilityPlan: CapabilityPlanTask[];
  runCapabilityDisclosure: CapabilityDisclosureState;
  taskActiveDelegation: TaskActiveDelegation | null;
  runLatestDelegationOutcome: AcceptedDelegationOutcome | null;
};
```

`plannerInitialized` 只是恢复完整性 metadata，不包含 Planner 内容。若 subgraph
checkpoint API 能直接可靠判断初始化状态，可以不增加此字段。

移除或替换：

- `runPlannerReturn`；
- `PlannerAnswerDisposition`；
- Planner direct-text fallback；
- boundary Planner 的 `completedTaskResult` accepted-result 假设；
- 独立 `DelegationOutcomeDecision` / `gap_note` contract；
- `delegationOutcomeDecision` graph node；
- Outcome 专用 prompt、schema builder 和 model runner。

`TaskActiveDelegation` 必须直接携带其所属 `traceId`。不要从 `transcriptRunId` 推断，
也不要使用 `taskActiveDelegation.id` 作为 trace identity。

## 目标 graph 路由

### Entry

```text
prepare
  -> compactContext
  -> entryDecision
       |-- answer -> answer
       `-- needs_plan -> Planner(initial boundary input)
                            |-- execute_plan -> capability
                            `-- unavailable -> answer
```

### Post execution

```text
capability
  -> deterministic iteration/handoff guards
  -> Planner(post-execution boundary input)
       |-- continue_current
       |     `-- preserve delegation -> capability
       |-- advance_plan
       |     `-- accept handoff -> complete delegation -> next capability
       |-- goal_done
       |     `-- accept handoff -> answer
       |-- user_input_required
       |     `-- preserve active delegation -> answer
       `-- unavailable
             `-- typed blocked state -> answer
```

Iteration limit 必须在调用 Planner 前由 code guard 检查。handoff availability 可以在
Planner commit 后由 graph 验证，但不能作为 Planner prompt 才知道的隐式规则。

## Answer 边界

Answer 不得读取 Planner lane。

Reply mode 的公开依据：

- `goal_done`：user request + accepted handoff + public artifacts；
- `user_input_required`：user request + root 投影的 structured question；Boundary 还可以
  附带 active delegation announce + public artifacts；
- `unavailable`：user request + registry/runtime 的确定性公开 facts；
- iteration/execution limit：guard state + active delegation evidence。

Planner action 可以决定 reply mode，但 Planner 的自由文本、tool observations 和内部
summary 不能成为 Answer context。

## 建议实现结构

新增：

```text
packages/pet-agent/src/agent/orchestrator/capabilityPlanner/
  protocol.ts
  runner.ts
  messageContext.ts
  agent.ts
```

职责建议：

- `protocol.ts`：`PlannerInput`、`PlannerCommit` 和结构约束；
- `runner.ts`：Planner invocation seam 和 root message updates；
- `messageContext.ts`：Planner lane 标记、Entry/Boundary 消息选择；
- `agent.ts`：Capability 探索工具和 terminal commit tools；
- `agent.ts` 同时负责 commit replay 和 message reconcile；
- root node 只包装 boundary input dispatch，并把 `PlannerCommit` 交给确定性 transition
  builder。

Planner terminal tools 建议改为：

```text
continue_current()
submit_plan(tasks)
advance_plan(tasks)
complete_goal()
request_user_input(question)
report_unavailable()
```

Planner system prompt 以目标和上下文为中心：说明 Planner 要形成的产物、
各类输入代表什么，以及可执行计划应达到的质量目标；不提供 Capability 搜索、
action 选择或计划改写的条件树。Terminal tool description 只说明提交的 action
和参数形状。`capability_search` 返回只提供本次披露的候选与轮次事实，不提供
`nextAction`、候选优先级或另一份决策政策。

Planner system message 不承载动态 Capability 文档或搜索轮次。每次调用根据
`CapabilityDisclosureState` 重新生成 `<capability_context>` 并放入本轮 Human input；
`general` 与 search 命中项使用同一结构，没有独立 default/fallback prompt block。
实际工具绑定决定 `capability_search` 是否可用，工具结果负责披露调用后的搜索状态。

成功调用 terminal tool 后应直接形成结构化 commit；不要再要求模型用普通文本确认，也
不要从普通 AI text 推导 fallback result。

### 当前实现到目标结构的迁移边界

本轮后续实现应作为一次结构替换完成，不保留两套并行机制：

1. 删除 `defaultCapability` invocation state、`<default_capability>` system block 和
   `readDefaultCapability()` 的特殊注入路径；
2. 在 trace/root runtime state 中加入 `CapabilityDisclosureState`，新 trace 用
   `general`（若存在）初始化；
3. search tool 继续通过官方 `ToolRuntime.state` 与 `Command.update` 处理单次调用及并行
   reducer，再由 runner/root transition 把披露增量和空轮次提交到 trace state；
4. Entry 与 Boundary 都从同一个 disclosure state 构建 `<capability_context>`；
5. Boundary 继续允许 search，但不重置已披露名称或空搜索额度；
6. 保持 `DelegationAnnounceMessage` 的标准 version 1 投影，删除 Planner prompt builder 中
   `PRIOR_CONTEXT_SUMMARY` 及其两条解释性 planning-state 文本；
7. 不增加兼容读取路径；旧 checkpoint 缺少 disclosure state 时按既有 checkpoint
   incompatibility 边界处理，或开始新 trace。

迁移完成后，Capability context 的唯一来源是 `CapabilityDisclosureState`，execution
Boundary evidence 的唯一来源是 canonical delegation announce 与选中的原始 transcript；
system prompt、Planner lane 文本和 result 字符串扫描都不能成为第二来源。

## 迁移计划

### Phase 0：固定基线与契约

- 为现有 graph 记录 lifecycle eval、模型调用数、token、延迟和失败率基线；
- 把现有 Outcome 场景映射为新的 Planner action 场景；
- 固定 `traceId/runId/delegationId` 语义；
- 定义 `PlannerInput`、`PlannerCommit` 和 runtime validation；
- 完成 Planner lane selection/reconcile 最小 spike，验证跨 turn 持久化、幂等 replay 和
  trace 隔离可以同时成立；
- 不修改生产路由。

### Phase 1：引入 trace identity

- 在 orchestrator input/state 中加入稳定 `traceId`；
- 新任务生成或接收新 `traceId`；
- in-flight `Command({ resume })` 保持旧 `traceId/runId`；
- 前一个 run 已结束后的 `resume_active` 保持旧 `traceId`、创建新 `runId`；
- delegation 和相关 telemetry 能关联回 `traceId`；
- 保持当前 Outcome + ephemeral Planner 行为不变。

### Phase 2：实现持久 Planner lane

- 使用 `orchestrator` lane 与稳定 source metadata 标记 Planner messages；
- Planner graph/agent 改为构建一次；
- 实现 input ID 去重、terminal ToolMessage replay 和 registry digest invalidation；
- 暂时通过 adapter 输出当前 `CapabilityPlannerResult`，生产 graph 仍保留 Outcome；
- 验证同一 trace 跨 run 恢复及新 trace 隔离。

### Phase 3：合并 Outcome 与 Planner contract

- Planner terminal tools 改为 `PlannerCommit` actions；
- post-capability route 从 Outcome 改到 Planner；
- 实现六种 action 的确定性 root transition；
- `continue_current` 复用 delegation；
- `advance_plan/goal_done` 执行 accepted handoff；
- `user_input_required/unavailable` 保留 truthful unfinished state；
- 通过 feature flag 或双 runner 保留可回退旧路径。

### Phase 4：删除旧 Outcome 和 Planner return 路径

- 删除独立 Outcome graph node、runner、schema 和 prompt；
- 删除 `runPlannerReturn` / `PlannerAnswerDisposition`；
- 删除 Planner direct text fallback 和普通文本确认轮；
- 更新 Answer context builder；
- 更新 raw `../..` 设计文档；
- 不修改 `../../wiki`，等待单独 ingest 请求。

### Phase 5：清理与默认启用

- 完成完整 lifecycle/model eval；
- 对比基线 latency、tokens 和 invocation counts；
- 默认启用新 Planner；
- 删除 feature flag 和旧 adapter；
- 确定 checkpoint retention 与 closed trace 清理策略。

## 测试计划

### Protocol 与 transition 单元测试

- 每个 action 的合法/非法 task shape；
- `continue_current` 没有 active delegation 时拒绝；
- `continue_current` capability 不一致时拒绝；
- terminal action 携带 tasks 时拒绝；
- `execute_plan` 空 tasks 时拒绝；
- Entry 的 `advance_plan` 与 Boundary 的 `execute_plan` 均拒绝；
- graph 对每个 commit 产生正确 state update 和 route；
- 不通过 prompt literal/regex 测试契约，只测试 schema 和可观察行为。

### Planner lane 隔离测试

- Planner AI/tool messages 进入 `OrchestratorState.messages` 的 `orchestrator` lane；
- main conversation、Answer 和 Capability selector 不读取 Planner lane；
- `capability_search` 文本不进入 handoff、Answer input 或 delegation summary；
- 新 trace 无法读取旧 trace Planner lane；
- 相同 `traceId` 在不同 conversation thread 之间仍然隔离。

### Root checkpoint 与恢复集成测试

- 同一 trace、新 run 恢复 Planner transcript；
- 用户输入后恢复 active delegation 和 Planner lane；
- 进程重启后从持久 backend 恢复；
- 已结束 run 的 fresh-turn continuation 保持 `traceId`、创建新 `runId`，并追加一个
  普通 Planner input；
- 相同 input 重复投递不会再次调用模型；
- supersede 后新 trace 不复用旧 state；
- registry digest 变化后重新验证 Capability。

### Lifecycle 场景

至少覆盖：

1. 单 task 完成整个目标 -> `goal_done`；
2. 当前 task 未完成 -> 同 delegation `continue_current`；
3. 调查结果驱动后续实现 -> `advance_plan`；
4. 最新结果使条件性后续 task 不再需要 -> `goal_done`；
5. sibling handoff 不替代当前 task evidence -> `continue_current`；
6. 当前 task 局部完成但必须等待用户输入 -> `user_input_required`；
7. 用户补充后以相同 trace、新 run 恢复；
8. 没有可执行 Capability -> `unavailable`；
9. 多 task trace 中 Planner 保留早期 Capability observation，但不向 main conversation 泄漏。

### Regression 与模型 eval

- 迁移现有 `outcome-decision-basics` 到 unified Planner action eval；
- 保留 Capability planning task-boundary eval；
- 跑完整 orchestrator lifecycle composition profile，每个模型场景至少重复三次；
- 所有现有 truthfulness criteria 和 mechanical invariants 不退化；
- 记录 schema failure、invocation failure、timeout 和 invalid transition；
- 比较旧/新架构的模型调用数、tokens、首个 capability 延迟和完整任务延迟。

## 可观测性

允许记录非语义 metadata：

- `traceId`、`runId`、`delegationId`；
- Planner action；
- task count 和 capability names；
- Planner lane message count；
- input dedupe hit；
- registry digest；
- token、latency、tool call count 和错误码。

默认 telemetry 不记录：

- Planner prompt/messages；
- Capability 文档正文；
- 被拒绝计划的自由文本；
- 内部 tool result 内容。

若现有 tracing callback 会自动采集 Planner messages，需要明确区分调试 trace 与产品公开
上下文，并遵守项目的日志/隐私配置。逻辑隔离不等同于遥测脱敏。

## 风险与缓解

### Planner 用新任务掩盖当前 task 未完成

风险：统一 Planner 可能过早搜索新 Capability，而不是要求当前 delegation 补齐结果。

缓解：

- post-execution boundary input 到达后先判断当前 task acceptance；
- `continue_current` 成为显式 terminal action；
- 只有 `advance_plan` 才接受当前 announce 并 materialize 新 delegation；
- eval 覆盖 incomplete announce、sibling evidence 和 repeated investigation。

### Planner lane 长期上下文变陈旧

缓解：registry digest invalidation、每个 execution result 作为新事实覆盖旧计划假设。

### Answer 缺少 Planner 的自由文本问题描述

这是有意设计。Answer 必须从公开用户请求、Capability announce、artifact 和 typed state
生成回复。若无法做到，说明缺少应由 executor 公开产出的 evidence，而不是 Planner 应该
泄漏私有推理。增加自由文本 Planner return 不作为修复方案。

### Checkpoint 体积持续增长

Planner lane 不做独立压缩；它与 root messages 一起保留。新 trace 清理旧 Planner lane，
且不把完整 workspace 文件复制进 checkpoint。

## 验收标准

- [ ] `traceId`、`runId`、`delegationId` 的语义在类型、runtime 和文档中一致；
- [ ] 同一 trace 在新 run 中恢复 Planner lane；
- [ ] 新 trace 与旧 trace、不同 thread 之间严格隔离；
- [ ] Planner agent 只构建一次，持久消息由 root Planner lane 拥有；
- [ ] Planner 只输出 `PlannerCommit.action + tasks`；
- [ ] Planner 不再输出 `reason/context/question/gap_note` 或 direct text；
- [ ] Planner transcript/tool observations/summary 进入 root Planner lane，但不进入 main conversation 或 Answer；
- [ ] 新 trace 的 disclosed Capability 以 `general`（若存在）为第一项，Entry/Boundary
      search 命中项按首次发现顺序追加；
- [ ] `CapabilityDisclosureState` 在同一 trace 的 Entry 与所有 Boundary 之间保留，
      registry digest 变化时重新初始化；
- [ ] system prompt 不包含 `<default_capability>` 或 capability search 轮次；
- [ ] search closed 后工具仍可调用并稳定返回超限结果，Planner 必须提交终态而不是
      `planner_incomplete`；
- [ ] `continue_current` 保持 delegation ID、lane 和 transcript；
- [ ] `execute_plan` 只用于 Entry 初始计划；
- [ ] `advance_plan` 与 `goal_done` 只在 graph 接受 handoff 后推进；
- [ ] `user_input_required` 不把未完成 delegation 标记为 completed；
- [ ] `unavailable` 不被表述为目标完成；
- [ ] Planner 不暴露需要 in-flight interrupt 的工具；未来如需支持则使用原生 subgraph；
- [ ] fresh-turn continuation 创建新 `runId` 并保持 `traceId`；
- [ ] 重复 Planner input 幂等且不重复调用模型；
- [ ] Planner lane updates 与 root transition 在同一 graph step 中提交；
- [ ] registry digest 变化不会复用过期 Capability availability；
- [ ] 独立 Outcome 模型节点和旧 contract 被删除；
- [ ] 现有 typecheck、unit tests 和 build 全部通过；
- [ ] lifecycle composition 和 unified Planner eval 无真实性回归；
- [ ] accepted non-terminal boundary 不再连续调用 Outcome + Planner；
- [ ] raw `../..` 已更新，`../../wiki` 未在本 issue 中修改。

## 完成定义

本 issue 只有在以下条件同时成立时才能关闭：

1. 新 Planner 默认用于 entry 和 post-execution planning；
2. 同一 trace 跨 run 的 Planner lane 恢复已通过 root checkpoint 测试；
3. Planner lane 与 main/delegation transcript 隔离有自动化回归测试；
4. 旧 Outcome 和 Planner return 路径已删除，而非仅停用；
5. lifecycle eval、成本与延迟对比报告已保存并可追溯；
6. 回滚 feature flag 已完成观察期并被清理，或已形成单独的清理 issue；
7. lane retention、trace closure 和 registry invalidation 均有明确运行时行为。
