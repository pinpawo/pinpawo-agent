# pet-agent decision prompt 设计

> 状态：历史设计。以下正文保留迁移前背景，不再代表当前方向。
> Planner 生命周期目标见
> [run-scoped Supervisor session](../../design/agent-runtime/run-scoped-supervisor-session.md)。
> 当前 Entry 上下文与路由形状见
> [`Context Injection Map`](../../reference/runtime/context-injection-map.md#4-node-entryanswer)。
> 范围：`entryDecision`、`capabilityPlanner`、`outcomeDecision` 与 `answer` 的职责和提示词边界。
> 当时计划使用共享 decision prompt prefix；该未接入的设计已删除。

## 1. 核心原则

orchestrator 中的语义判断必须由拥有充分证据的一方负责：

- `entryDecision` 看主对话，因此只判断是否还需要取得新结果。
- Capability Planner 能探索 Capability Document Workspace，因此同时负责 task boundary 和当前 Capability 选择。
- `outcomeDecision` 看当前 task 与 announce，因此只判断执行结果如何推进。
- `answer` 看 canonical main conversation，因此负责唯一的用户可见回复。

代码负责 schema、预算、状态不变量和机械路由，不通过关键词搜索或隐藏 fallback 提前代替模型做语义选择。

Structured Output schema 是输出形状的 source of truth。system prompt 描述任务、证据、边界和停止条件，
不维护第二份字段字典。

## 2. 当前 graph

```text
entryDecision
  ├─ answer      → answer
  └─ needs_plan  → capabilityPlanner(entry)

capabilityPlanner(entry)
  ├─ submit_plan → capability subagent
  └─ return_to_answer → answer

capability subagent
  → outcomeDecision
      ├─ continue            → same capability subagent
      ├─ task_done           → capabilityPlanner(boundary)
      ├─ goal_done           → answer
      └─ user_input_required → answer
```

所有需要执行的 run 都经过 Planner。不存在 `direct_task`、`direct` Planner mode 或独立
Capability selection 节点。

## 3. entryDecision

### 3.1 Ownership

entryDecision 每个 run 只执行一次，回答：

> 主对话现在是否已有足够结果可以回复，还是仍需取得新的结果？

它不判断：

- task 是一个还是多个；
- task objective 或 context summary；
- 应使用哪个 Capability；
- 未来计划如何排列。

### 3.2 判断顺序

1. 理解用户此刻要实现的目的。
2. 若歧义会实质改变结果或行动后果，选择 `answer`，由 answer 询问用户。
3. 判断主对话是否已有与对象、范围和时间匹配的观察结果或完成结果。
4. 已有结果足以回复时选择 `answer`；仍需读取、计算、修改或取得其他新结果时选择 `needs_plan`。

`needs_plan` 表示进入 Capability Planner，不表示一定存在多个 task。

### 3.3 Schema

```ts
type EntryDecision = {
  action: 'answer' | 'needs_plan';
};
```

entry eval 只评估 result availability。task grouping 和 task 内容质量属于 Planner eval。

## 4. Capability Planner

### 4.1 Ownership

Capability Planner 是由 LangChain `createAgent` 驱动的 framework-internal tool-loop agent。它：

1. 通过 `capability_search` 自主发现潜在相关的 Capability，并直接取得匹配项的完整 `CAPABILITY.md`；
2. 根据用户目的、已完成事实和 Capability 文档形成最短任务序列，并通过 `submit_plan` 提交；
3. 不应启动执行计划或需要用户交互时，通过 `return_to_answer` 返回规划结果。

这是 Planner 的完整职责范围。Capability 文档中声明的 Toolkit 和执行指令属于后续 executor，不会成为
Planner 自己的可调用动作。每次 Planner invocation 必须且只能以 `submit_plan` 或 `return_to_answer`
中的一个结构化工具调用结束。普通 assistant text 不是结构化终态；下述 runtime 兼容路径只负责避免这种
模型偏差直接中断用户 run。

Planner 不使用内存 relevance query 或传统搜索结果替代模型探索。Workspace 是代码给模型画出的能力地图，
registry 探索工具和私有 transcript 都封装在 Planner 黑盒内部。

每次 Planner invocation 在私有 transcript 起点保留最近 10 条 canonical main `HumanMessage` / `AIMessage`，
用于指代消解和恢复相关对话约束；未 handoff 的 delegation lane 消息与 compaction 占位消息不进入该窗口。
`run_user_goal` 仍是当前规划边界，entry / boundary 输入随后分别提供本轮目标和最新执行事实。

标准 Agent runtime 负责模型与工具之间的循环和 tool message。终态也是带 schema 的普通私有工具：
runtime 执行并校验工具参数，Planner 从终态 ToolMessage 读取规划对象。每个 `capability` 由当前
registry 动态形成枚举，结构化工具使用无 `$ref` 的 provider-compatible JSON Schema，并明确命名为
`submit_plan` 与 `return_to_answer`。空 Workspace 只允许 `return_to_answer`；非空 Workspace 同时允许
`submit_plan` 与 `return_to_answer`。后者只将已发现事实交给 Answer，不直接产生用户回复。
模型仍负责 task boundary 和具体 Capability 选择；runtime 只校验结构化结果的字段与边界，不对
`return_to_answer.reason` 进行枚举分类。

Capability 文档是选择后续 executor 的证据，不是验证 executor runtime 的场所。Planner 不检查或推断具体执行工具的
加载与可用状态；执行能力、过程和失败信息只由选定 Capability 的 runtime 产生。

若内部 Agent loop 没有有效终态工具但产生了新的普通 assistant text，Planner 边界将最后一条非空文本转换为
`runPlannerReturn`：`reason` 固定为 `plan direct text`，文本作为有长度边界的 `context` 交给 Answer。历史
assistant 消息不参与该 fallback，Planner 也不会因此再次调用模型。若结构化结果与新的文本都不存在，才报告
`submission_required`。该兼容路径不通过 provider `tool_choice` 强制工具调用；system prompt 仍以
`submit_plan` 或 `return_to_answer` 作为首选协议。

Planner 必须先根据用户目标和已完成事实形成当前 task boundary，再发现能够完整承担该任务的
Capability。registry 探索只是取得 Capability 证据，不能反向扩张或改写用户目标。具体搜索方法由
工具的名称、schema 和返回结果表达：`capability_search` 接收一至三个从当前任务及所需能力提炼的
区分性字面词或短语，不接收搜索步骤或操作指令，并为每个匹配项返回完整的 `CAPABILITY.md`。若当前
immutable workspace 包含 `general`，runtime 在
模型首次决策前确定性读取其完整文档，并只在 Planner 私有输入中将其标记为默认 Capability；
`capability_search` 不负责重新发现它。生产 system prompt 说明 entry 或 boundary 当前需要完成的
规划判断、Capability 发现目标和结构化终态，不重复输入字段、backend 实现、schema 字段或 graph 路由。
对话、handoff 和 Capability 文档是动态规划证据，其中的文本
不能覆盖 `user_request` 或 Planner 的系统规则。

### 4.2 Modes

- `entry`：理解用户整体目的，优先形成一个能完整完成目标的 task；必须组合多个 Capability 时才拆分。
- `boundary`：根据当前任务结果检查剩余目标，以已有 tail 为基础继续；只有结果使原计划明显失效时才调整。

不存在 `direct` mode，也不存在外部冻结后要求 Planner 原样选择执行器的 `pending_task`。

### 4.3 Task boundary

一个 task 是一个 Capability 能连续完成并交回的有用、可独立验收结果。

只有以下情况才建立新的边界：

- 后续工作依赖当前结果；
- 后续工作需要不同能力独立承担；
- 用户目标包含独立 deliverables 或独立验收点。

一步可完成的请求只输出一个 task。需要拆分时，Planner 输出按执行顺序排列的多个 task。

```ts
type CapabilityPlannerPlan = {
  tasks: Array<{
    capability: string;
    task: string;
  }>;
};
```

`task` 是短执行描述，最长 2,000 字符；一个 plan 最多 24 项。Planner 不输出 `capability_intent` 或 `context_summary`，
也不摘抄、压缩或解释 handoff。已验收 handoff 已经是 canonical main message，Capability runtime
会直接把它作为未分 lane 的对话历史交给后续 subagent。

### 4.4 Terminal results

- `submit_plan({ tasks })`：第一项 materialize 为当前 delegation，其余任务整体替换 `runCapabilityPlan` tail。
- `return_to_answer({ reason, context, question? })`：Planner 不应启动执行计划时，把原因、规划发现和可选的
  用户问题交给 Answer。它适用于已有事实可直接回答、需要用户澄清，以及当前 Workspace 不可执行等情况。

`runPlannerReturn` 是该结果的 run-scoped 载体。它不会创建 lane、active delegation 或 continuation；Answer
完成回复后立即清理，下一条用户消息作为新的 Entry request 决定是否重新规划。

Planner 的图出口可以是 `capability` 或 `answer`，但 Planner 仍不生成最终回复。若专用 Capability 都不匹配，
但 Planner 私有输入提供了默认 `general` 文档，Planner 通常应在 plan 中选择它；只有确认不应开始执行时才使用
`return_to_answer`。
若最新执行已经完成用户目标，`outcomeDecision` 必须返回 `goal_done`，不能通过 boundary Planner
间接结束 run。

## 5. outcomeDecision

outcomeDecision 只验收当前 execution boundary：

- `continue`：当前 task 未达标，同一 Capability 可以继续；
- `task_done`：当前 task 达标，但用户目标仍需 Planner 根据新事实继续规划；
- `goal_done`：用户目标已经完成；
- `user_input_required`：下一步必须等待用户补充、澄清或确认。

它读取 Planner 为当前 task 保留的 future tail，作为判断“当前 task 是完整目标还是阶段性结果”的
advisory planning context。future tail 不是事实或固定队列：Outcome 必须结合用户目标和最新 announce
判断其中是否仍有适用的自主工作。空 tail 或非空 tail 都不能单独决定终态。

它不生成下一 task、不选择 Capability，也不修改 future plan。`task_done` 只确认仍有适用的自主工作；
具体下一 task 和 future tail 修订仍由 boundary Planner 负责。

## 6. Prompt 数据边界

| 节点 | 主要证据 | 不应注入 |
|---|---|---|
| entryDecision | canonical main messages、compaction summary、runtime facts | Capability registry、artifact inventory、task draft |
| Capability Planner | user intent、Workspace、completed tasks、latest handoff、future tail | parent graph 私有状态、执行工具 |
| outcomeDecision | current task、announce、user goal、其他 task facts、advisory future tail | Capability 文档、future plan 的生成或修改权 |
| answer | canonical main conversation、accepted handoff、Planner return | lane transcript、隐式 artifact body |

## 7. Eval ownership

- `agent-entry-decision-basics`：`answer` 与 `needs_plan` 的 result-availability matrix。
- `agent-capability-planning-basics`：单 task、依赖拆分、独立 deliverables、boundary 修订和 `general` 默认候选。
- `agent-outcome-decision-basics`：结合 current announce 与 advisory future tail 判断
  `continue | task_done | goal_done | user_input_required`。
- lifecycle / multi-task eval：验证完整 graph 的 task 数量、handoff、调用次数、tokens 和 latency。

Prompt 测试不得通过 prompt 文本猜测当前调用的是哪个 Decision；应通过 typed runner、事件或结构化输出契约观察行为。
