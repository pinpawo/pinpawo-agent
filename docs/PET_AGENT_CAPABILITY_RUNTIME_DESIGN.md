# Pet Agent Capability Runtime Design

> 状态：Historical v4。V2 已删除 `createRuntime`、动态 instructions、通用
> Capability middleware、Capability availability 和 executable
> `resultSchema`。当前契约见
> [Capability / Toolkit Contract V2](./PET_AGENT_CAPABILITY_TOOLKIT_V2_DESIGN.md)。
> 日期：2026-03-30
> 说明：本文描述当前实现。已接受的下一代目标契约见
> [Capability / Toolkit Contract V2](./PET_AGENT_CAPABILITY_TOOLKIT_V2_DESIGN.md)；
> 在迁移完成前，两者必须明确区分为 implementation fact 与 design target。
> 2026-06-19 对齐：结构化 capability result 已迁移为
> `CapabilityArtifactRef` / `kind: "result"` artifact；subagent completed
> announce 是返回给父 agent 的自然语言 handoff 结果，不是短 preview。
> 2026-07-19 对齐：delegation briefing 进入私有 lane；announce 通过显式
> `announceMessageId` 交付；answer/main 只按 lane 与 provenance 划分消息。

## 1. 文档目标

这份文档定义 `packages/pet-agent/` 中 capability 机制的运行模型。

它解决的问题是：

- capability 如何定义业务能力
- capability 如何通过 subagent 执行
- capability 之间如何保持独立
- capability 结果如何被 host 读取

## 2. 核心概念

系统只有两个核心概念：

1. **capability**：业务定义层，声明一个能力提供什么 tools、什么 instructions、产出什么 result
2. **subagent**：运行机制层，动态创建一个独立的子 agent 来执行具体能力

### 2.1 capability

capability 是一个自包含的业务能力定义。

它主要声明三件事：

1. uses/tools：该能力需要复用的 toolkit，以及该能力自带的工具
2. instructions：该能力的执行指令
3. result contract：该能力对外的结构化产出

capability 不负责：

- 管理自己的执行环境
- 读取其他 capability 的状态
- 持久化长期状态
- 管理 checkpoint
- 暴露框架级运行时事件

### 2.2 subagent

subagent 是通用的运行机制，不特定于任何 capability。

它负责：

- 动态创建一个子 agent
- 为子 agent 装配 tools 和 instructions
- 执行子 agent 的 agent loop
- 收集并返回执行结果

subagent 的关键特性：

- **动态创建**：在需要时创建，不在初始化阶段预构建
- **隔离执行**：每个 subagent 有自己独立的 tools 和 instructions
- **用完即弃**：执行完成后 subagent 销毁，不保留运行状态

### 2.3 两者的关系

```
capability（定义 WHAT）→ 通过 subagent 执行（HOW）→ 返回 result
```

- capability 定义能力的内容
- subagent 提供执行的机制
- capability 使用 subagent 来运行，但 subagent 本身是通用的，不绑定任何具体 capability

## 3. 运行模型

### 3.1 orchestrator

主 agent 作为 orchestrator，负责：

- 接收用户消息
- 根据对话内容判断是否直接回复，或委托给某个 capability
- 通过动态创建 subagent 来执行 capability
- 接收 subagent 返回的结果，继续对话

orchestrator 不需要 activation 机制。它决定调用哪个 capability 时，直接创建 subagent 执行。

### 3.2 capability 执行流程

```
orchestrator 收到消息
  → 判断需要使用某个 capability
  → 动态创建 subagent（装配该 capability 声明的 toolkits/toolsets + instructions）
  → subagent 执行 agent loop
  → subagent 返回结果
  → orchestrator 拿到结果，继续对话或调用下一个 capability
```

### 3.3 toolkit 与 tool 隔离

toolkit 是可复用工具族，capability 通过 `uses` 显式声明需要哪些 toolkit。详见 [PET_AGENT_TOOLKIT_COMPOSITION_DESIGN.md](./PET_AGENT_TOOLKIT_COMPOSITION_DESIGN.md)。

每个 capability 最终装配出的 tools 只存在于其 subagent 内部：

- orchestrator 看不到 capability 的 tools
- capability A 的 subagent 看不到 capability B 的 tools
- capability A 只能看到自己 `uses` 的 toolkit tools
- 不需要 guard 机制、activation 机制、middleware 动态过滤

### 3.4 数据流

capability 之间不直接通信。数据流转路径：

```
capability A 的 subagent 执行 → 返回结果给 orchestrator →
orchestrator 将结果作为上下文 → 传给 capability B 的 subagent
```

orchestrator 是 capability 之间唯一的数据中介。

## 4. capability 接口

### 4.1 AgentCapability

```typescript
type AgentCapability = {
  name: string;
  description: string;
  availability?: CapabilityAvailabilityConfig;
  createRuntime: (ctx: CapabilityContext) => CapabilityRuntime | Promise<CapabilityRuntime>;
  resultSchema?: ZodType;
};
```

- `name`：唯一标识
- `description`：描述该能力做什么，供 orchestrator 判断何时调用
- `availability`：可选的 host 启动期可用性检查；不可用的 capability 不进入 registry
- `createRuntime`：在 subagent 创建时调用，生成 uses/toolsets/instructions/middleware
- `resultSchema`：可选，定义该 capability 的 `kind: "result"` JSON artifact
  payload schema。schema 约束的是结构化 artifact 内容，不替代 subagent
  announce。

### 4.2 CapabilityContext

```typescript
type CapabilityContext = {
  models: AgentModels;
  actor: AgentActor;
  messages: BaseMessage[];
  execution?: AgentExecution;
  availableToolkits?: ReadonlyArray<{ name: string; description: string }>;
  artifactStore?: CapabilityArtifactStore;
};
```

context 只包含 agent 级别的公共信息、当前可用 toolkit 描述和可选 artifact store port。
它不包含其他 capability 的私有 runtime 或 transcript。

### 4.3 CapabilityRuntime

```typescript
type CapabilityRuntime = {
  uses?: string[];
  toolsets?: AgentToolset[];
  instructions?: string[] | ((ctx: CapabilityInstructionContext) => string[] | Promise<string[]>);
  middleware?: CapabilityMiddleware;
};
```

runtime 是 subagent 的配置：它使用哪些 toolkit、带哪些 capability-private toolsets、用什么 instructions，以及可选的输入/输出调整 hook。

- `uses`：声明要装配的 toolkit，例如 `['browser']`、`['bash']`
- `toolsets`：capability-private 工具组；capability-local tools 必须通过这里暴露，并在同一 toolset 内声明 operation metadata / review policy。
- toolkit tools 的可见性只由 `uses` 决定；不再提供按工具名继承 global/toolkit tools 的兼容层。

```typescript
type CapabilityMiddleware = {
  beforeRun?: (input: SubagentRunInput) => SubagentRunInput | Promise<SubagentRunInput>;
  afterRun?: (
    result: SubagentResult,
    ctx: CapabilityMiddlewareContext,
  ) => SubagentResult | Promise<SubagentResult>;
};
```

约束：

- middleware 只用于 subagent 输入/输出调整
- middleware 不负责 capability activation 或 tool 可见性控制

### 4.4 capability result schema

- `resultSchema` 用于声明该 capability 的结构化 `kind: "result"` artifact
  payload 形状
- capability 在 `afterRun` 或 in-loop ingest 中通过
  `CapabilityArtifactStore.writeArtifact(...)` 写入结果 artifact，并通过
  `recordCapabilityArtifact(ref)` 把 ref 交回 orchestrator
- 解析/校验成功的结果不再写入 `capabilityResult` 字段；orchestrator state
  只保存 `CapabilityArtifactRef`
- subagent 的 completed announce 仍是父 agent 当前轮判断和回复用户的自然语
  言结果；结构化 result artifact 是给程序/host/后续能力按需读取的通道

## 5. subagent 接口

subagent 是通用的运行机制，不特定于 capability。

### 5.1 创建

subagent 在 orchestrator 需要执行某个 capability 时动态创建：

```typescript
// 概念性接口
type SubagentInputState = {
  instructions: string[];
  messages: BaseMessage[];
};

type SubagentRunInput = SubagentInputState & {
  model: BaseChatModel;
  tools: StructuredTool[];
};

type SubagentResult = {
  messages: BaseMessage[];
  artifacts: CapabilityArtifactRef[];
  completionReason: 'natural' | 'limit_reached' | 'error';
  announceMessageId: string | null;
};
```

### 5.2 生命周期

1. orchestrator 决定调用某个 capability
2. 创建 subagent，装配 toolkit tools、capability toolsets 和 instructions
3. subagent 执行自己的 agent loop
4. subagent 返回结果
5. subagent 销毁

subagent 不跨调用保留状态。

补充约束：

- checkpoint 只属于 orchestrator graph，不进入 subagent
- `threadId` 不作为 subagent checkpoint；host 还可用它限定 artifact store/discovery 的当前 thread 目录
- subagent 不暴露 `onEvent` 这类框架事件接口
- subagent 的稳定输出是 `messages / artifacts / completionReason / announceMessageId`。
- `completionReason` 只表达停止原因；它不直接判定 delegated task 是否完成。
- 自然结束时，只有最终消息是无 tool call 的 `AIMessage` 才会成为 announce，
  `createSubagent` 返回该消息的 ID。orchestrator 后续按 ID 标记、验收和 handoff，
  不根据消息正文或“最后一条有文本的消息”推断。
- guard/recursion limit 停止时，`createSubagent` 从尾部回找最近一条非 guard、无 tool call、
  有非空文本的 `AIMessage`；若本轮没有可交付文本，则 `announceMessageId` 为 `null`。
- `artifacts` 只携带 refs，不携带大 payload。

## 6. orchestrator 的结构

orchestrator 使用 LangGraph StateGraph，把入口判断、规划、能力选择、执行、验收和最终回复拆成
垂直节点。当前主路径是：

```text
START → prepare → compactContext
  → entryDecision
      ├─ answer → END
      ├─ capabilityPlanner → capabilityDecision
      └─ capabilityDecision
  → capability | general
  → delegationOutcomeIterationGuard
  → delegationOutcomeDecision
      ├─ continue → capability | general
      ├─ task_done → capabilityPlanner
      └─ goal_done → answer → END
```

- `entryDecision` 只选择 `answer | direct_task | needs_plan`。
- `capabilityPlanner` 只维护 capability execution boundaries。
- `capabilityDecision` 搜索具体 Capability；没有匹配时选择普通的
  `general` fallback Capability。
- `capability/general` 创建隔离 subagent 并执行当前 delegation。
- `delegationOutcomeDecision` 验收 announce，决定继续、完成当前 task 或完成总目标。
- `answer` 是唯一生成用户可见最终回复的节点。

### 6.1 当前 state 分层

`messages` 是唯一未带生命周期前缀的 LangGraph channel；其余 state 按 session/task/run 分层：

- session：`sessionCapabilityArtifacts`、`sessionToolAuthorizations`
- task：`taskActiveDelegation`
- run：`runNextDelegation`、`runPendingTask`、`runCapabilityPlan`、
  `runDelegationSummaries`、`runIterationCount`、`runId`

完整命名与 reset 纪律见
[PET_AGENT_STATE_LIFECYCLE_REFACTOR.md](./PET_AGENT_STATE_LIFECYCLE_REFACTOR.md) 和
[PET_AGENT_DELEGATION_STATE_AND_TASK_ROUTING.md](./PET_AGENT_DELEGATION_STATE_AND_TASK_ROUTING.md)。

### 6.2 main queue、delegation lane 与 briefing

同一 `messages` channel 物理承载 main queue 和 delegation lanes，但消费者按 metadata 建立不同视图：

- `mainConversationMessages()` 返回无 lane 的 main 消息，并按系统写入的
  `source: delegation_briefing` provenance 排除 pre-lane briefing；带 handoff provenance 的
  已验收副本仍保留。
- `laneMessages()` 返回 main 基础上下文与当前 lane+runId+delegationId 的私有 transcript。
- 消息身份由 lane、message ID 和 handoff provenance 决定，不从正文内容推断。

`DelegationSpec` 是向下派发的事实来源。`materializeDelegation()` 确定性地产生两个投影：

- initial delegation：main 中一条简短计划；selected lane 中一条 XML
  `<delegation_briefing>`。
- continuation：只向原 lane 写入新的 briefing/gap，不重复 main 计划。

XML 只是给执行模型读取的投影，不被 runtime 反向解析。稳定执行规则留在 subagent governing
prompt；briefing 只承载 task、必要上下文或 continuation gap。

### 6.3 announce 与 handoff

subagent 通过 `announceMessageId` 明确交付候选。outcomeDecision 验收完成后：

1. 把 announce 复制为普通、无 lane 的 main `AIMessage`。
2. 在 metadata 中记录 `handoffFrom/delegationId/runId/task/announceMessageId`。
3. 清空该 lane+runId+delegationId 的原 announce 与执行 transcript。

未完成或达到执行限制时不 handoff，lane 保留用于续跑。answer 只读取 main queue，不扫描 lane，
也不对输出正文做 briefing 文本匹配、重试或替换。缺少当前身份字段的旧 checkpoint 不通过正文
猜测兼容。

### 6.4 orchestrator 与 capability runtime

capability 的 instructions、toolkits、private toolsets 和 middleware 只在 selected subagent 内生效；
orchestrator decision/answer 节点不持有这些执行工具。host 可以给 selected subagent 额外装配
受限的 artifact discovery tools，但它们不进入 entryDecision。

## 7. capability 间数据流

### 7.1 数据通过 orchestrator 传递

capability 之间不共享私有 transcript。一次 run 可以由 planner 组织多个串行 delegation：

1. capability A 执行当前 task，在自己的 lane 中形成 announce。
2. outcomeDecision 验收后把 announce handoff 到 main，并清空 A 的 lane。
3. boundary planner 基于完整 handoff 修订 future tail，materialize 下一个 task。
4. capabilityDecision 为下一个 task 重新选择 executor，capability B 只看到 main 结论和自己的 briefing。

因此 capability 间传递的是 main handoff 结论与显式 artifact refs，不是另一能力的工具流水。

### 7.2 业务规则的归属

跨 capability 的业务规则由 orchestrator 或 capability 自己的 instructions 承载：

- orchestrator instructions：描述 capability 之间的协作规则（如"视频热点需要用 daily_post 的 repost 模式"）
- capability instructions：描述自身的执行规则

不需要 capability 之间在代码层面互相感知。

### 7.3 tool options 与外部数据

capability 的 tool 需要的外部数据（trendItems, recentDaily 等），通过 capability factory options 注入，由 channel 在构造 capability 时提供：

```typescript
// implemented by the host layer, for example services/local-agent
createDailyPostCapability({
  trendItems,
  recentDaily,
  savePost,
});
```

这些数据不来自其他 capability。

## 8. capability result

### 8.1 result 的语义

result 是 capability 在一次执行中对 host 的结构化产出。当前实现中，result
是 `kind: "result"` 的 capability artifact，而不是 graph state 里的内联
`capabilityResult` JSON。

它的消费者是 host（channel / graph service / scheduler），不是其他 capability。
父 agent/`delegation_outcome` 的自然语言判断仍读取 subagent completed
announce；只有需要结构化数据或大 payload 时才读取 result artifact。

### 8.2 result 的生命周期

1. capability 声明 `resultSchema`
2. subagent 执行过程中产生 tool output / 模型结论
3. capability 代码在折叠前校验 payload，并写入 `kind: "result"` artifact
4. 写入成功后返回 `CapabilityArtifactRef`，经 artifact sink 进入
   `SubagentResult.artifacts`
5. orchestrator 将 ref 合入 graph state 的 `sessionCapabilityArtifacts`
6. host 在 graph invoke 完成后从 `sessionCapabilityArtifacts` 找到目标 ref，再通过
   artifact store 读取和 parse

### 8.2.1 多个 result 的选择规则

`sessionCapabilityArtifacts` 是 session 级 ref 索引，不是单个 result 槽。一次 graph
invoke 里可以有多个 `kind: "result"` artifact：不同 capability 各自写入、
同一 capability 多次委派、或一个 capability 写入多个结构化产物。

host 读取结构化结果时必须带选择范围，例如：

- 按 `capabilityId` 选择某个 capability 的 result
- 按 `delegationId` / `runId` 选择某次执行的 result
- 按 `schema.name` / `schema.version` 选择某个 contract 的 result
- 当一个 capability 写多个 result 时，按 `metadata.role` 等小字段区分语义

只有在这些 selector 缩小范围之后，才可以取其中最新的一个。不存在跨所有
capability 的“全局 latest result”语义。

### 8.3 result 的来源约束

- `kind: "result"` artifact ref 代表一次 capability 执行成功写入的结构化结果
- 它属于 graph invoke 的最终 state，而不是 `runAgent` 的标准返回值
- chat 场景通常只消费 `reply / messages`
- task / scheduler 场景如果需要结构化结果，应通过 graph service 读取最终
  state 中的 `sessionCapabilityArtifacts`，再读取对应 artifact 内容

## 9. graph 构建与运行入口

### 9.1 createOrchestratorGraph

`createOrchestratorGraph(config)` 由 channel 在初始化时调用一次。

它负责：

- 接收 `OrchestratorConfig`（models, actor?, checkpoint）
- 构建 entry/planner/capability/outcome/answer StateGraph
- 编译 graph（绑定 checkpointer）
- 返回已编译的 `OrchestratorGraph`

```typescript
type OrchestratorConfig = {
  models: AgentModels;
  actor?: AgentActor;
  checkpoint?: BaseCheckpointSaver;
};
```

### 9.2 runAgent

`runAgent(graph, input)` 是每次消息到达时的调用入口。

它负责：

- invoke 已编译的 graph
- 传递 messages 以及 configurable 中的 `actor?/threadId/capabilities/toolkits/execution`
- 返回 reply / messages

```typescript
type AgentInvokeInput = {
  messages: BaseMessage[];
  actor?: AgentActor;
  threadId?: string;
  capabilities?: AgentCapability[];
  toolkits?: AgentToolkit[];
  execution?: AgentExecution;
};

type AgentRunResult = {
  reply: string;
  messages: BaseMessage[];
};
```

capability results 不经过 `runAgent` 返回值。需要结构化结果时，应读取最终 graph state 中的 `sessionCapabilityArtifacts`，再通过 artifact store 读取对应 `kind: "result"` artifact。

actor 规则：

- 如果 graph 在初始化时已经绑定 `OrchestratorConfig.actor`，后续 invoke 可以不再传 actor
- 如果 graph 没有绑定 actor，则 invoke 时必须传入 actor
- API channel 通常使用动态 actor
- local-agent 通常在启动时静态绑定 actor

`runAgent` 不负责：

- 构建 graph（已由 channel 完成）
- 构造模型（已在 config 中）
- 返回 capability result（由 graph state 承载）
- activation 管理（StateGraph routing 替代）
- tool 可见性控制（subagent 天然隔离）
- 暴露框架运行时事件（如 `onEvent`）

## 10. 设计约束

### 10.1 与主设计文档的关系

主设计文档 [PET_AGENT_REWRITE_DESIGN.md](./PET_AGENT_REWRITE_DESIGN.md) 保留：

- capability 是 skill-like 扩展
- capability result 的公共接口
- capability 注册与 channel 的集成方式

以下细节以本文件为准：

- capability + subagent 的分层模型
- subagent 动态创建机制
- tool 隔离规则
- capability 间数据流模型
- orchestrator 的结构

### 10.2 设计参考

参考了 Claude Code 中 skills 和 subagents 的分工方式：

- skill 定义能力内容（WHAT）
- subagent 提供隔离执行（HOW）
- 两者分层，互不绑定

## 11. 一句话总结

> capability 定义业务能力（toolkits/toolsets + instructions + result），通过动态创建 subagent 执行；subagent 是通用的隔离执行机制，capability 之间通过 orchestrator 传递数据，互不感知。
