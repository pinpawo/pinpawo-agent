# 能力与工具契约 API

> 本文描述当前已实现 API。已接受但尚未完成迁移的 V2 目标见
> [Capability / Toolkit Contract V2](./PET_AGENT_CAPABILITY_TOOLKIT_V2_DESIGN.md)。

## 1. 能力定义

```ts
type AgentCapability = {
  name: string;
  description: string;
  availability?: {
    check: () => CapabilityAvailability | Promise<CapabilityAvailability>;
    cache?: 'startup' | 'none';
  };
  createRuntime: (ctx: CapabilityContext) => CapabilityRuntime | Promise<CapabilityRuntime>;
  resultSchema?: ZodType;
};
```

## 2. Capability 上下文与运行时

```ts
type CapabilityContext = {
  models: AgentModels;
  actor: AgentActor;
  messages: BaseMessage[];
  execution?: AgentExecution;
  availableToolkits?: ReadonlyArray<{ name: string; description: string }>;
  /** Host-provided artifact persistence port, optional for deterministic writes. */
  artifactStore?: CapabilityArtifactStore;
};

type CapabilityRuntime = {
  uses?: string[];
  toolsets?: AgentToolset[];
  instructions?: string[] | ((ctx: CapabilityInstructionContext) => string[] | Promise<string[]>);
  middleware?: {
    beforeRun?: (input: SubagentRunInput) => SubagentRunInput | Promise<SubagentRunInput>;
    afterRun?: (
      result: SubagentResult,
      ctx: CapabilityMiddlewareContext,
    ) => SubagentResult | Promise<SubagentResult>;
  };
};
```

### 规则

1. `uses` 声明能力依赖 toolkit 名称，运行时自动注入对应工具集。
2. `toolsets` 为能力私有工具，建议通过 `defineToolset` 静态定义，避免重复工具名。
3. `middleware.afterRun` 常用于在代码侧持久化 capability 产物（例如把结构化结果写入 artifact store），并把 ref 回传给 orchestrator。
4. `afterRun` 新增用户可交付消息时，必须同时返回该消息的 `announceMessageId`；lane tagging 不从正文或消息位置推断身份。
5. `SubagentRunInput` 是一次 subagent run 的完整输入；`SubagentInputState` 才是进入 subagent graph 的 state 形状。

`artifactStore` 为可选依赖，能力需要容错处理未注入的场景（例如测试）。

## 3. Toolkit 定义

```ts
type AgentToolkit = {
  name: string;
  description: string;
  availability?: CapabilityAvailabilityConfig;
  tools?: ToolkitResource<StructuredTool[]>;
  instructions?: ToolkitResource<string[]>;
  operations?: ToolOperationMetadataMap;
  policy?: ToolkitPolicy;
};
```

建议优先使用：

1. `defineToolkit(...)`：定义静态工具 + metadata + policy
2. `defineToolset(...)`：定义只含 tools 的结构化工具集合

### Toolkit 与审批

1. `policy.toolReview` 用于工具风险控制。
2. `ToolAuthorizationMatcher` 可在策略中返回鉴权规则。
3. `toolAuthorizations` 会通过 `SubagentContext` 流向工具执行层（见 review 相关类型）。

## 4. 常见组合方式

1. **Pet runtime 构建时注入**：通过 `PetAgentRuntimeConfig.toolkits`
2. **单次调用扩展**：通过 `PetAgentRuntimeInvokeInput.toolkits`
3. **单次能力注入（planner）**：通过 `PetAgentRuntimeInvokeInput.extraCapabilities`

## 5. 相关导出

1. `CapabilityArtifactStore`、`CapabilityArtifactRef`、`CapabilityArtifactWriteInput`：见 `packages/pet-agent/src/types/artifact.ts`
2. `CapabilityContext`、`CapabilityRuntime` 与 `CapabilityMiddleware`：见 `packages/pet-agent/src/types/capability.ts`
3. toolkit 与 policy：见 `packages/pet-agent/src/types/toolkit.ts`
