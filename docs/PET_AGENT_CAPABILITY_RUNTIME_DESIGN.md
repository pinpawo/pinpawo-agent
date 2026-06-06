# Pet Agent Capability Runtime Design

> 状态：Draft v3
> 日期：2026-03-30

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
  createRuntime: (ctx: CapabilityContext) => CapabilityRuntime | Promise<CapabilityRuntime>;
  resultSchema?: ZodType;
};
```

- `name`：唯一标识
- `description`：描述该能力做什么，供 orchestrator 判断何时调用
- `createRuntime`：在 subagent 创建时调用，生成 toolsets / tools fallback + instructions
- `resultSchema`：可选，定义该 capability 的结构化结果 schema

### 4.2 CapabilityContext

```typescript
type CapabilityContext = {
  models: AgentModels;
  actor: AgentActor;
  messages: BaseMessage[];
  execution?: AgentExecution;
};
```

context 只包含 agent 级别的公共信息。不包含其他 capability 的引用或状态。

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
  beforeRun?: (input: SubagentInput) => SubagentInput | Promise<SubagentInput>;
  afterRun?: (result: SubagentResult) => SubagentResult | Promise<SubagentResult>;
};
```

约束：

- middleware 只用于 subagent 输入/输出调整
- middleware 不负责 capability activation 或 tool 可见性控制

### 4.4 capability result schema

- `resultSchema` 用于声明该 capability 的结构化结果形状
- orchestrator 在 subagent 执行完成后，会尝试从 tool 输出中解析该 schema
- 解析成功的结果会被写入 graph state 的 `capabilityResult`

## 5. subagent 接口

subagent 是通用的运行机制，不特定于 capability。

### 5.1 创建

subagent 在 orchestrator 需要执行某个 capability 时动态创建：

```typescript
// 概念性接口
type SubagentInput = {
  model: BaseChatModel;
  tools: StructuredTool[];
  instructions: string[];
  messages: BaseMessage[];
};

type SubagentResult = {
  reply: string;
  messages: BaseMessage[];
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
- `threadId` 只用于 orchestrator graph 的 checkpoint 作用域
- subagent 不暴露 `onEvent` 这类框架事件接口
- subagent 的稳定输出只有 `reply / messages`

## 6. orchestrator 的结构

orchestrator 使用 LangGraph StateGraph 实现，包含三个节点和条件路由。

### 6.1 StateGraph 结构

```
START → route → (conditional) → capability → END
                              → direct    → END
```

- **route 节点**：作为主 orchestrator agent 运行；如果需要 capability，则调用 `delegate_capability` 工具；否则直接生成自由文本回复
- **capability 节点**：创建 subagent 执行对应 capability（装配 capability tools + global tools）
- **direct 节点**：不创建 subagent；只把 route 节点已经生成的自由文本回复写入最终 `messages`

### 6.2 OrchestratorState

```typescript
const OrchestratorState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  routeMode: Annotation<'direct' | 'capability'>({
    reducer: (_prev, next) => next,
    default: () => 'direct',
  }),
  activeCapability: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  directReply: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  capabilityTask: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  capabilityContextSummary: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  capabilityResult: Annotation<Record<string, unknown> | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
});
```

- `messages`：动态的对话消息，每次调用传入
- `routeMode`：当前走 direct 还是 capability
- `activeCapability`：route 节点委托的 capability 名称
- `directReply`：route 节点直接生成的自由文本回复
- `capabilityTask`：交给 capability 的明确任务
- `capabilityContextSummary`：交给 capability 的简短上下文摘要
- `capabilityResult`：最近一次 capability 执行解析出的结构化结果

静态配置（models，以及可选的 actor）通过闭包持有。tools、capabilities 通过每次 invoke 的 configurable 输入提供，不放在 state 中。

### 6.3 graph 构建与调用分离

- **`createOrchestratorGraph(config)`**：channel 在初始化时调用一次，构建并编译 StateGraph
- **`runAgent(graph, input)`**：每次消息到达时调用，invoke 已编译的 graph

这个分离确保 graph 不会在每次消息时重建。

### 6.4 route 节点的 system prompt

route 节点的 system prompt 包含：

- 宠物角色信息（名称、性格）
- 直接回复与 capability 委托规则
- 可用 capability 的名称和描述
- `delegate_capability` 工具的使用约束

route 节点不是轻量分类器，而是主 orchestrator agent 的一次推理。

它的行为只有两种：

1. 直接回复用户，生成自由文本
2. 调用 `delegate_capability`，给出：
   - `capability`
   - `task`
   - `context_summary`

它不再输出五字段 JSON 路由结果。

### 6.5 orchestrator 与 capability runtime

capability 的 instructions 和 tools 在 subagent 内部生效，不注入 orchestrator。

orchestrator 自身不持有任何 capability 的 tools。

当前版本补充：

- global tools 由 channel 作为动态输入提供
- capability 节点创建 subagent 时会装配 `global tools + capability tools`
- direct 路径不创建 subagent，因此不会在 direct 回复阶段调用 global tools

如果 capability runtime 提供了 `middleware`：

- 由 orchestrator 在调用 `createSubagent(...)` 前后执行
- 作用域仍然局限在当前 capability runtime
- 不改变 orchestrator 的路由职责

## 7. capability 间数据流

### 7.1 数据通过 orchestrator 传递

capability 之间不共享 state。数据流转通过 orchestrator 的 messages 自然发生。

在当前 StateGraph 模型中，每次 graph invoke 只执行一个 capability（或 direct）。多 capability 协作通过多轮对话实现：

1. 第一轮消息 → route 判断调用 trend_observe → subagent 执行，返回结果进入 messages
2. 第二轮消息（包含上轮结果）→ route 判断调用 daily_post → subagent 从 messages 获取热点信息，执行写动态

LLM 作为数据中介，通过 message history 自然传递 capability 之间的信息。

### 7.2 业务规则的归属

跨 capability 的业务规则由 orchestrator 或 capability 自己的 instructions 承载：

- orchestrator instructions：描述 capability 之间的协作规则（如"视频热点需要用 daily_post 的 repost 模式"）
- capability instructions：描述自身的执行规则

不需要 capability 之间在代码层面互相感知。

### 7.3 tool options 与外部数据

capability 的 tool 需要的外部数据（trendItems, recentDaily 等），通过 capability factory options 注入，由 channel 在构造 capability 时提供：

```typescript
createDailyPostCapability({
  trendItems,
  recentDaily,
  savePost,
});
```

这些数据不来自其他 capability。

## 8. capability result

### 8.1 result 的语义

result 是 capability 在一次执行中对 host 的结构化产出。

它的消费者是 host（channel / graph service / scheduler），不是其他 capability。

### 8.2 result 的生命周期

1. capability 声明 `resultSchema`
2. subagent 执行过程中产生 tool output
3. orchestrator 在 capability 节点结束时尝试解析 `resultSchema`
4. 解析成功的结果写入最终 graph state 的 `capabilityResult`
5. host 在 graph invoke 完成后读取 `capabilityResult`

### 8.3 result 的来源约束

- `capabilityResult` 只代表最近一次 capability 执行成功解析出的结果
- 它属于 graph invoke 的最终 state，而不是 `runAgent` 的标准返回值
- chat 场景通常只消费 `reply / messages`
- task / scheduler 场景如果需要结构化结果，应通过 graph service 读取最终 state

## 9. graph 构建与运行入口

### 9.1 createOrchestratorGraph

`createOrchestratorGraph(config)` 由 channel 在初始化时调用一次。

它负责：

- 接收 `OrchestratorConfig`（models, actor?, checkpoint）
- 构建 StateGraph（route → capability/direct 条件路由）
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

capability results 不经过 `runAgent` 返回值。需要结构化结果时，应读取最终 graph state 中的 `capabilityResult`。

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
