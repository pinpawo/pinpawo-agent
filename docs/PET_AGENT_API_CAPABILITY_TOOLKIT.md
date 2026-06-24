# 能力与工具契约 API

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
};

type CapabilityRuntime = {
  uses?: string[];
  toolsets?: AgentToolset[];
  contextPolicy?: SubagentContextPolicy;
  instructions?: string[] | ((ctx: CapabilityInstructionContext) => string[] | Promise<string[]>);
  middleware?: {
    beforeRun?: (input: SubagentInput) => SubagentInput | Promise<SubagentInput>;
    afterRun?: (result: SubagentResult) => SubagentResult | Promise<SubagentResult>;
  };
  readResult?: (messages: BaseMessage[]) => unknown | null;
};
```

### 规则

1. `uses` 声明能力依赖 toolkit 名称，运行时自动注入对应工具集。
2. `toolsets` 为能力私有工具，建议通过 `defineToolset` 静态定义，避免重复工具名。
3. `middleware.afterRun` 常用于包装 capability 产物，不做持久化存储职责。

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

1. `readResult` 通道：`packages/pet-agent/src/index.ts` 导出的 `readLatestToolArtifact`
2. 详见 `packages/pet-agent/src/types/capability.ts` 与 `packages/pet-agent/src/types/toolkit.ts`
