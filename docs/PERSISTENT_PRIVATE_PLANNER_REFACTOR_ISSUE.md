# refactor(orchestrator): merge outcome decisions into a trace-scoped persistent private Planner

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
   带回 root，与 Planner 私有上下文边界不一致。

我们希望保留 Outcome 所代表的执行验收语义，但删除独立的 Outcome 模型节点，将其
并入一个在完整用户任务中持续存在的私有 Planner actor。

## 决策摘要

将 Capability Planner 重构为一个 **trace-scoped persistent private Planner**：

- 一个用户任务/目标对应一个稳定的 `traceId`；
- 每次执行、唤醒或恢复拥有独立的 `runId`；
- Planner 私有状态以 `threadId + traceId` 为持久化边界；
- Planner 在同一 trace 的多个 run、delegation 和用户输入中断之间保持上下文；
- Planner 接管执行边界的验收与后续规划；
- root graph 继续独占 handoff、delegation 生命周期、路由和公开状态更新；
- Planner 对 root 只提交结构化 control action 和 plan tasks；
- Planner transcript、工具消息、Capability 文档观察、内部摘要和自由文本不得进入
  root state、main messages、Answer input 或 handoff。

目标流程：

```text
entryDecision
  -> private Planner
  -> capability
  -> private Planner
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
| `traceId` | 一次用户任务/目标，跨中断与恢复 | Planner 私有状态和完整任务链路 |
| `runId` | 一次已经开始的 root graph run | 运行时 guard、遥测和单次执行边界 |
| `delegationId` | 一个具体 Capability task | Capability lane、transcript 和执行结果归属 |

关系不是简单的 `run -> delegation` 树：一个 delegation 可能在新的 run 中继续执行，
但仍然属于同一个 trace。

```text
threadId
  `-- traceId
       |-- Planner private state
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
3. 同一 `traceId` 下跨 `runId` 恢复 Planner 私有上下文；
4. 同一 delegation 继续执行时保留其 ID、lane 和 transcript；
5. 把 Planner 的所有内部消息与公开 orchestrator 上下文隔离；
6. 只允许 Planner 向 root 提交 control action、plan tasks 和必要的 opaque
   checkpoint metadata；
7. 保持 graph 对状态转移、handoff、guard 和用户可见回复的最终所有权；
8. 支持 checkpoint resume、幂等重试、进程重启和 trace 隔离；
9. 保持或提升现有 lifecycle eval 的真实性与稳定性；
10. 减少 accepted non-terminal boundary 上重复的独立模型决策。

## 非目标

- 不把 Planner transcript 合并进 `OrchestratorState.messages`；
- 不让 Planner 直接生成用户可见回复；
- 不让 Planner 直接修改 root state 或执行 handoff；
- 不让 capability agent 自行决定 task 或用户目标是否完成；
- 不依赖 `completionReason` 推导 task 成败；
- 不改变 Capability 文档的公开格式或 registry backend；
- 不在本 issue 中修改 `docs/wiki/` 或执行 wiki ingest；
- 不要求立即物理删除已关闭 trace 的历史 checkpoint；清理由 retention policy 负责。

## 核心不变量

### 1. Planner 是 trace-scoped，而不是 run-scoped

- 新用户任务创建新 `traceId`；
- 对尚未结束的 graph interrupt 执行原生 checkpoint resume 时，保持原 `runId` 和
  `traceId`，从中断位置继续；
- 前一个 run 已经结束、用户在新请求中通过 `resume_active` 继续同一任务时，创建新
  `runId`，但保持 `traceId`；
- 同一 trace 内的所有 Planner invocation 读取同一个私有 Planner checkpoint；
- `supersede_active` 或明确的新目标创建新 `traceId`；
- 新 trace 不得读取旧 trace 的 Planner state。

### 2. Planner 状态是私有状态

以下内容只能存在于 Planner checkpoint namespace：

- Planner human/AI/tool messages；
- `capability_search` 结果和 Capability 文档观察；
- 规划过程、被拒绝的候选计划和内部推理；
- Planner 自己的 context compaction summary；
- 已处理 input IDs、内部 current plan 和 last commit；
- registry digest 及其对应的私有缓存状态。

这些内容不得进入：

- `OrchestratorState.messages`；
- main message lane；
- Capability handoff copy；
- Answer prompt；
- root 的 compaction input；
- 面向调用方的事件或 API response；
- `runDelegationSummaries.resultPreview`。

### 3. Planner 只有一个受控输出出口

Planner 只提交 `PlannerCommit`。除 plan task 文本外，不允许输出任意语义文本。

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
};
```

`action` 是 graph control protocol，不是用户内容。`tasks` 是唯一允许从 Planner
私有边界向外投影的语义内容。

移除以下 Planner 输出形式：

- `reason`；
- `context`；
- `question`；
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
- `tasks.length >= 1`；
- `tasks[0].capability` 必须与 active delegation capability 相同；
- graph 保留现有 `delegationId`、lane 和 transcript；
- `tasks[0].task` 作为新的 continuation instruction 注入同一 delegation；
- `tasks.slice(1)` 是 Planner 当前承诺的未来计划；
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
- 下一项 task 可以选择不同的 Capability；
- Planner 不得用它掩盖当前 task 的缺口。

### `goal_done`

适用条件：当前结果与已有公开事实已经完成用户目标。

约束：

- post-execution 阶段必须存在可接受的 announce；
- `tasks` 必须为空；
- graph 接受 handoff、完成 delegation，并以 `goal_done` 进入 Answer；
- Planner 私有文本不能用于完成总结；Answer 只能基于公开请求、accepted handoff
  和 artifact 生成回复。

### `user_input_required`

适用条件：目标尚未完成，并且下一次进展必须先等待用户补充、选择或确认。

约束：

- `tasks` 必须为空；
- post-execution 阶段保留 active delegation 与 transcript；
- 不把未完成 announce 标记为 completed handoff；
- Answer 根据公开用户请求、当前 announce、artifact 和 typed outcome 提出问题；
- Planner 不输出 `question` 或自由文本 context；
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
continue_current     -> active delegation + non-empty tasks + same capability
execute_plan         -> entry + non-empty tasks
advance_plan         -> boundary + non-empty tasks
goal_done            -> empty tasks + accepted-result preconditions
user_input_required  -> empty tasks
unavailable          -> empty tasks
```

模型非法输出必须作为 Planner invocation failure 处理，不能通过松散 normalize 把一个
action 静默改写成另一个 action。

## Planner 私有输入协议

每次 Planner 正常开始一个新决策 turn 时，Root 只追加当前 boundary 的新事实，不重建
完整 Planner transcript，也不发明一套 Planner 专属的 resume command。

```ts
type PlannerInput = {
  inputId: string;
  traceId: string;
  runId: string;
  userGoal: UserGoal;
  latestUserMessage: string | null;
  activeDelegation: PlannerDelegationInput | null;
  latestAnnounce: PlannerAnnounceInput | null;
  committedPlan: CapabilityPlanTask[];
  registryDigest: string;
};
```

字段是否存在表达当前 boundary：

- 初次规划：没有 active delegation 和 announce；
- delegation 返回：包含 active task、完整 announce candidate、stop reason 和 artifact
  refs；
- 前一个 run 已结束后的用户继续：包含 latest user message 和 resumable delegation；
- registry 变化：在下一次正常 Planner input 中提供新的 digest。

这里的“用户继续”只是 Planner 已完成上一轮 commit 后收到的一个新输入 turn，不是
checkpoint resume，也不需要 `user_resumed` 事件。Capability announce 本来属于 execution
evidence；Planner 只消费它，不拥有它。

## Checkpoint 与恢复设计

### 两类恢复必须分开

Capability subagent 当前已经区分两种机制，Planner 应复用相同语义：

#### In-flight checkpoint resume

当 Planner 内部的工具、审批或其他节点调用 LangGraph `interrupt()` 时：

- Planner 尚未提交 `PlannerCommit`；
- parent graph 和 Planner child graph 都停在同一个 checkpoint lineage；
- 调用方对 parent graph 发送普通 `Command({ resume })`；
- child 继承 parent runnable config/checkpointer，从原中断位置继续；
- 保持同一个 `traceId` 和 `runId`；
- 不调用 `resume_active`；
- 不构造新的 `PlannerInput`；
- 不增加 Planner 专属 resume event、resume API 或状态重建逻辑。

这应与 `createSubagent` 当前“child 不自带 checkpointer、通过 parent config 继承并由 bare
`Command({ resume })` 重入”的机制保持一致。

#### Fresh-turn task continuation

当 Planner 已经提交 `user_input_required`，Answer 已回复用户，前一个 root run 已正常
结束，之后用户通过新请求继续同一任务时：

- 这是一个新的 root run，因此创建新 `runId`；
- 仍属于同一用户任务，因此保持 `traceId`；
- Planner 读取同一 trace 的已完成私有历史；
- root 追加一个包含最新用户消息和 active delegation 的普通 `PlannerInput`；
- Planner 从新的 decision turn 开始，而不是恢复已经结束的旧程序计数器。

只有前一种情况叫“哪里停止哪里恢复”。后一种情况是同一持久 actor 收到下一条输入，
不应伪装成 LangGraph interrupt resume。

### 持久化作用域

Planner 使用 root 已配置的持久化 backend 和相同 `thread_id`，由 LangGraph 原生 subgraph
checkpoint namespace 隔离 child state。`traceId` 是 Planner state 的生命周期身份和隔离
条件，不要求调用方另外管理一个 Planner thread/session。

Planner graph/agent 必须在 orchestrator 构建时创建一次，不得在每次 invocation 内重新
`createAgent`。

Root 与 Planner 使用不同 state schema，因此生产组合采用 LangGraph 的标准 wrapper
模式：在 Root node function 内调用预编译的 Planner subgraph。生产 Planner 使用
`checkpointer: true` 继承 parent checkpointer 并跨同一 trace 的 invocation 保留状态；
无 parent checkpointer 的直接单测/eval 使用单独预编译的 `checkpointer: false` adapter。
这两个 graph 都只在 runner 构建时创建，不得在 `invoke()` 内动态编译。
Planner 私有 state 由拥有这些字段的 middleware 声明一次，再由 `createAgent` 自动合并；不要
在 agent 与 middleware 上重复注册同一份 state schema。

优先把 Planner 作为 parent graph 的原生持久 subgraph，使其继承 parent checkpointer 和
runnable config。不能为了 trace 持久化而把 Planner 变成一个 detached checkpoint workflow，
否则会破坏 bare `Command({ resume })` 从 root 重入 pending child interrupt 的能力。

实现前必须用一个最小 spike 验证所选 LangGraph 组合同时满足：

1. Planner child interrupt 可由 parent 的 bare `Command({ resume })` 原地恢复；
2. Planner 正常完成一次 commit 后，同 trace 的下一次 invocation 能读取旧私有 state；
3. 新 trace 不会读取旧 trace 私有 state。

如果 LangGraph 自动 child namespace 不能同时提供第 2、3 点，可以在原生 subgraph 模型
内增加 trace-keyed private state/reset，或使用 framework 支持的 checkpoint namespace
配置；不要另外定义 Planner thread、session 或专属 resume protocol。

Capability discovery 的调用预算使用标准 `toolCallLimitMiddleware` 按单次 Planner input
限制，不再定义自有的并行 reducer/counter，计数和并行批次裁剪交给 middleware 的内置
run state。若 effective workspace 包含 `general`，runtime 必须在模型首次决策前读取经过
workspace 校验的完整 General 文档，并只把它注入 Planner 私有输入，作为不依赖字面搜索的
默认候选。`capability_search` 只负责发现更具体的 Capability，不返回 `fallback` 字段。Planner 在提交
`report_unavailable` 前必须先评估默认 General；它能执行当前工作时应选择它。显式受限 workspace
可以没有 General，此时只有全部可见 Capability 都不能执行时才能提交 `unavailable`。

### 幂等输入消费

Planner private state 保存 `processedInputIds` 和对应的 last commit。建议 input ID：

```text
trace_started:<traceId>
announce:<delegationId>:<announceMessageId>
human:<humanMessageId>
```

registry digest 是 input 的事实字段，不需要单独模拟成 resume/event。重复 input 必须返回
已提交的同一 commit，不得再次调用模型或重复追加 Planner messages。

### Parent/child checkpoint 一致性

必须覆盖以下失败窗口：

```text
Planner 已持久化 commit
  -> process crashes
  -> root 尚未持久化相应 transition
```

恢复后 root 会重放相同 `inputId`；Planner 必须返回原 commit，使 root transition 可以
安全重试。

如果所选 LangGraph subgraph 集成不能保证 parent/child checkpoint lineage，一种可接受
的实现是由 root 保存 opaque Planner checkpoint revision/cursor。该 metadata 只能用于
一致性恢复，不能包含 Planner 语义内容。

### 缺失或损坏的 Planner checkpoint

Root 必须能区分：

- 新 trace 尚未初始化 Planner；
- 已初始化 trace 的 Planner checkpoint 丢失或损坏。

后一种情况不得静默创建一个空 Planner 并继续。graph 应进入 typed blocked state，避免
在缺少规划上下文时重新解释已执行一半的任务。

### Context compaction

Planner 使用独立的 context budget、watermark 和 compaction。Planner summary：

- 只写回 Planner private state；
- 不写入 main messages；
- 不进入 root compaction；
- 必须保留当前目标、accepted/rejected boundary、committed tasks、关键 Capability
  observations 和尚未关闭的依赖；
- 必须可从 checkpoint 恢复后继续规划。

### Registry 变化

持久上下文可能包含过期 Capability 文档观察。Planner private state 必须记录
`registryDigest`。digest 变化时：

- 保留与用户目标和 execution result 相关的历史；
- 将 Capability availability 和文档观察视为需重新验证；
- 重新 materialize workspace；
- 不允许仅凭旧 transcript 选择已经删除或不可用的 Capability。

## Root state 调整

新增或明确：

```ts
type OrchestratorTraceState = {
  traceId: string;
  runId: string;
  plannerInitialized: boolean;
  runCapabilityPlan: CapabilityPlanTask[];
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

`TaskActiveDelegation` 应携带或可确定其所属 `traceId`。不要使用
`taskActiveDelegation.id` 作为 trace identity。

## 目标 graph 路由

### Entry

```text
prepare
  -> compactContext
  -> entryDecision
       |-- answer -> answer
       `-- needs_plan -> Planner(initial boundary input)
                            |-- execute_plan -> capability
                            |-- user_input_required -> answer
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

Answer 不得读取 Planner private checkpoint。

Reply mode 的公开依据：

- `goal_done`：normalized user goal + accepted handoff + public artifacts；
- `user_input_required`：user goal + active delegation announce + public artifacts；
- `unavailable`：user goal + registry/runtime 的确定性公开 facts；
- iteration/execution limit：guard state + active delegation evidence。

Planner action 可以决定 reply mode，但 Planner 的自由文本、tool observations 和内部
summary 不能成为 Answer context。

## 建议实现结构

新增：

```text
packages/pet-agent/src/agent/orchestrator/privatePlanner/
  graph.ts
  state.ts
  protocol.ts
  inputs.ts
  checkpoint.ts
  agent.ts
  prompts/
  index.ts
```

职责建议：

- `protocol.ts`：`PlannerInput`、`PlannerCommit` 和结构约束；
- `state.ts`：只属于 Planner 的 state schema；
- `inputs.ts`：boundary input 构造和幂等消费；
- `checkpoint.ts`：trace namespace 与恢复完整性；
- `agent.ts`：Capability 探索工具和 terminal commit tools；
- `graph.ts`：私有 Planner graph、内部 compaction 和 commit extraction；
- root node 只包装 boundary input dispatch，并把 `PlannerCommit` 交给确定性 transition
  builder。

Planner terminal tools 建议改为：

```text
continue_current(tasks)
submit_plan(tasks)
advance_plan(tasks)
complete_goal()
request_user_input()
report_unavailable()
```

成功调用 terminal tool 后应直接形成结构化 commit；不要再要求模型用普通文本确认，也
不要从普通 AI text 推导 fallback result。

## 迁移计划

### Phase 0：固定基线与契约

- 为现有 graph 记录 lifecycle eval、模型调用数、token、延迟和失败率基线；
- 把现有 Outcome 场景映射为新的 Planner action 场景；
- 固定 `traceId/runId/delegationId` 语义；
- 定义 `PlannerInput`、`PlannerCommit` 和 runtime validation；
- 完成 Planner child checkpoint/resume 最小 spike，验证原生 resume、跨 turn 持久化和
  trace 隔离可以同时成立；
- 不修改生产路由。

### Phase 1：引入 trace identity

- 在 orchestrator input/state 中加入稳定 `traceId`；
- 新任务生成或接收新 `traceId`；
- in-flight `Command({ resume })` 保持旧 `traceId/runId`；
- 前一个 run 已结束后的 `resume_active` 保持旧 `traceId`、创建新 `runId`；
- delegation 和相关 telemetry 能关联回 `traceId`；
- 保持当前 Outcome + ephemeral Planner 行为不变。

### Phase 2：实现持久私有 Planner

- 创建独立 state schema 和 checkpoint namespace；
- Planner graph/agent 改为构建一次；
- 实现 input ID 去重、last commit replay 和 registry digest invalidation；
- 实现 Planner 私有 compaction；
- 暂时通过 adapter 输出当前 `CapabilityPlannerResult`，生产 graph 仍保留 Outcome；
- 验证同一 trace 跨 run 恢复及新 trace 隔离。

### Phase 3：合并 Outcome 与 Planner contract

- Planner terminal tools 改为 `PlannerCommit` actions；
- post-capability route 从 Outcome 改到 private Planner；
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
- 更新 raw `docs/` 设计文档；
- 不修改 `docs/wiki/`，等待单独 ingest 请求。

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

### 私有状态隔离测试

- Planner AI/tool messages 不进入 `OrchestratorState.messages`；
- `capability_search` 文本不进入 handoff、Answer input 或 delegation summary；
- Planner compaction summary 不进入 root compaction；
- root snapshot 只包含 action、tasks 和 opaque checkpoint metadata；
- 新 trace 无法读取旧 trace 私有 state；
- 相同 `traceId` 在不同 conversation thread 之间仍然隔离。

### Checkpoint 与恢复集成测试

- 同一 trace、新 run 恢复 Planner transcript；
- 用户输入中断后恢复 active delegation 和 Planner state；
- 进程重启后从持久 backend 恢复；
- in-flight interrupt resume 保持原 `traceId/runId`，且不会追加新的 Planner input；
- 已结束 run 的 fresh-turn continuation 保持 `traceId`、创建新 `runId`，并追加一个
  普通 Planner input；
- Planner commit 后、root transition 前故障，恢复时重放相同 commit；
- 相同 input 重复投递不会再次调用模型；
- Planner 内部 interrupt 通过 parent bare `Command({ resume })` 从原位置恢复；
- 已初始化 trace 丢失 Planner checkpoint 时 fail closed；
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
9. Planner 内部发生 compaction 后继续正确规划；
10. 多 task trace 中 Planner 保留早期 Capability observation，但不向 root 泄漏。

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
- checkpoint namespace/revision；
- input dedupe hit；
- registry digest；
- token、latency、tool call count 和错误码。

默认 telemetry 不记录：

- Planner private prompt/messages；
- Capability 文档正文；
- Planner compaction summary；
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

### 私有长期上下文变陈旧

缓解：registry digest invalidation、Planner 私有 compaction、每个 execution result 作为新
事实覆盖旧计划假设。

### Parent/child checkpoint 不一致

缓解：相同 input ID 的 commit replay、opaque revision 或 LangGraph 原生 subgraph
lineage、故障注入测试。

### Answer 缺少 Planner 的自由文本问题描述

这是有意设计。Answer 必须从公开用户请求、Capability announce、artifact 和 typed state
生成回复。若无法做到，说明缺少应由 executor 公开产出的 evidence，而不是 Planner 应该
泄漏私有推理。增加自由文本 Planner return 不作为修复方案。

### Checkpoint 体积持续增长

缓解：独立 token budget、私有 compaction、closed trace retention、artifact/document
观察摘要化；不把完整 workspace 文件复制进 checkpoint。

## 验收标准

- [ ] `traceId`、`runId`、`delegationId` 的语义在类型、runtime 和文档中一致；
- [ ] 同一 trace 在新 run 中恢复 Planner 私有上下文；
- [ ] 新 trace 与旧 trace、不同 thread 之间严格隔离；
- [ ] Planner 使用持久 checkpointer，且不在每次 invocation 重新创建；
- [ ] Planner 只输出 `PlannerCommit.action + tasks`；
- [ ] Planner 不再输出 `reason/context/question/gap_note` 或 direct text；
- [ ] Planner transcript/tool observations/summary 不进入 root state 或 Answer；
- [ ] `continue_current` 保持 delegation ID、lane 和 transcript；
- [ ] `execute_plan` 只用于 Entry 初始计划；
- [ ] `advance_plan` 与 `goal_done` 只在 graph 接受 handoff 后推进；
- [ ] `user_input_required` 不把未完成 delegation 标记为 completed；
- [ ] `unavailable` 不被表述为目标完成；
- [ ] Planner in-flight interrupt 使用 parent bare `Command({ resume })` 原地恢复；
- [ ] in-flight resume 保持原 `runId`；fresh-turn continuation 才创建新 `runId`；
- [ ] 重复 Planner input 幂等且不重复调用模型；
- [ ] Planner/root checkpoint 故障窗口可安全恢复；
- [ ] registry digest 变化不会复用过期 Capability availability；
- [ ] 独立 Outcome 模型节点和旧 contract 被删除；
- [ ] 现有 typecheck、unit tests 和 build 全部通过；
- [ ] lifecycle composition 和 unified Planner eval 无真实性回归；
- [ ] accepted non-terminal boundary 不再连续调用 Outcome + Planner；
- [ ] raw `docs/` 已更新，`docs/wiki/` 未在本 issue 中修改。

## 完成定义

本 issue 只有在以下条件同时成立时才能关闭：

1. 新 Planner 默认用于 entry 和 post-execution planning；
2. 同一 trace 跨 run 的持久恢复已通过真实 checkpoint backend 测试；
3. Planner 私有上下文隔离有自动化回归测试；
4. 旧 Outcome 和 Planner return 路径已删除，而非仅停用；
5. lifecycle eval、成本与延迟对比报告已保存并可追溯；
6. 回滚 feature flag 已完成观察期并被清理，或已形成单独的清理 issue；
7. checkpoint retention、trace closure 和 registry invalidation 均有明确运行时行为。
