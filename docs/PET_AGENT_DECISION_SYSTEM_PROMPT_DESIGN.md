# pet-agent decision prompt 设计

> 状态：Capability Planner Agent cutover 后的当前生产契约。
> 范围：`entryDecision`、`capabilityPlanner`、`outcomeDecision` 与 `answer` 的职责和提示词边界。
> 共享前缀：[`PET_AGENT_ORCHESTRATOR_DECISION_PROMPT_PREFIX.md`](./PET_AGENT_ORCHESTRATOR_DECISION_PROMPT_PREFIX.md)。

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
  ├─ next_task   → capability subagent
  └─ unavailable → answer

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

Capability Planner 是 framework-internal tool-loop agent。它：

1. 通过 `glob_search`、`grep_search`、`view_file_chunk` 自主探索 `CAPABILITY.md`；
2. 根据用户目的、已完成事实和 Capability 文档形成当前 task boundary；
3. 选择能够完整承担当前 task 的 concrete Capability；
4. 维护尚未开始的 future plan tail。

Planner 不使用内存 relevance query 或传统搜索结果替代模型探索。Workspace 是代码给模型画出的能力地图，
文件工具和私有 transcript 都封装在 Planner 黑盒内部。

### 4.2 Modes

- `entry`：从用户整体目的形成当前 task 和必要的 future tail。
- `boundary`：结合 completed tasks、最新完整 handoff 和已有 tail 修订下一 task。

不存在 `direct` mode，也不存在外部冻结后要求 Planner 原样选择执行器的 `pending_task`。

### 4.3 Task boundary

一个 task 是一个 Capability 能连续完成并交回的有用、可独立验收结果。

只有以下情况才建立新的边界：

- 后续工作依赖当前结果；
- 后续工作需要不同能力独立承担；
- 用户目标包含独立 deliverables 或独立验收点。

一步可完成的请求输出 `next_task` 和空 `remaining_plan`。需要拆分时，Planner 输出当前
`next_task` 与非空 future tail。

### 4.4 Terminal results

- `next_task`：materialize 当前 delegation，并整体替换 `runCapabilityPlan` tail。
- `unavailable`：探索后确认 registry 中没有任何可执行 Capability，且 registry 未注册 `general`。

`runPendingTask` 只在 `unavailable` 时保存未执行 task 与原因，供 answer 生成可见说明；它不再是
entryDecision 与 Planner 之间的 staging state。

Planner 没有 `answer` 出口。进入 Planner 已表示当前目标仍需取得新结果；若专用 Capability 都不匹配，
但 registry 注册了 `general`，Planner 必须读取 `general/CAPABILITY.md` 并以 `next_task` 选择它。
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
| answer | canonical main conversation、accepted handoff、unavailable payload | lane transcript、隐式 artifact body |

## 7. Eval ownership

- `agent-entry-decision-basics`：`answer` 与 `needs_plan` 的 result-availability matrix。
- `agent-capability-planning-basics`：单 task、依赖拆分、独立 deliverables、boundary 修订和 `general` fallback。
- `agent-outcome-decision-basics`：结合 current announce 与 advisory future tail 判断
  `continue | task_done | goal_done | user_input_required`。
- lifecycle / multi-task eval：验证完整 graph 的 task 数量、handoff、调用次数、tokens 和 latency。

Prompt 测试不得通过 prompt 文本猜测当前调用的是哪个 Decision；应通过 typed runner、事件或结构化输出契约观察行为。
