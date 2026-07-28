# Pet Runtime API

## 1. 入口

### 工厂

```ts
createPetAgentRuntime(config: PetAgentRuntimeConfig): PetAgentRuntime
```

### 核心类型

```ts
type PetAgentRuntime = {
  descriptor: () => PetAgentRuntimeDescriptor;
  invoke: (input: PetAgentRuntimeInvokeInput) => Promise<PetAgentRuntimeInvokeResult>;
};

type PetAgentRuntimeInvokeInput = {
  brief: string;
  wikiRoot?: string;
  signal?: AbortSignal;
  threadId?: string;
  execution?: AgentExecution;
  workdir?: string;
  runtimeEnvironment?: string;
  toolkits?: AgentToolkit[];
  extraCapabilities?: AgentCapability[];
  allowedCapabilityNames?: string[];
};

type PetAgentRuntimeInvokeResult = { reply: string };
```

## 2. 配置 `PetAgentRuntimeConfig`

```ts
type PetAgentRuntimeConfig = {
  models: AgentModels;
  actor: AgentActor;
  role?: string | null;
  serviceSummary?: string | null;
  startupMode?: 'standby' | 'lazy' | 'disabled';
  status?: PetAgentStatus;
  capabilities?: AgentCapability[];
  toolkits?: AgentToolkit[];
  execution?: AgentExecution;
  workdir?: string;
  humanReviewer?: HumanReviewer;
  graph?: OrchestratorGraph;
  checkpoint?: OrchestratorConfig['checkpoint'];
  decisionStructuredOutput?: OrchestratorConfig['decisionStructuredOutput'];
  contextWindowTokens?: OrchestratorConfig['contextWindowTokens'];
  subagentContextWindowTokens?: OrchestratorConfig['subagentContextWindowTokens'];
};
```

## 3. 调用契约

1. 入参 `brief` 为必填自然语言任务文本。
2. `wikiRoot` 可选；存在时会读取 `{wikiRoot}/index.md`，注入 `SystemMessage`。
3. `extraCapabilities` 仅在本次调用生效，与 runtime 级能力合并。
4. `allowedCapabilityNames` 可把本次调用的 Capability Document Workspace
   限制为指定名称；不传时 Planner 可以探索完整的 compiled registry。
5. `invoke()` 是最终结果接口，不接收工具事件 callback；需要实时工具/运行时事件的宿主应消费 root `streamEvents(v3)` 并通过 adapter 投影。
6. Toolkit availability 在每次 invoke 的 registry generation 中解析；Capability
   是否可用由编译后的 registry 及其 diagnostics 决定。

## 4. 返回值与行为

1. `invoke()` 成功返回 `reply`，不返回 envelopes。
2. 若执行命中 HITL interrupt 且未配置 `humanReviewer`，会抛错：
   - `Pet agent "<petId>" hit HITL interrupt but no humanReviewer configured`
3. 运行时状态会在调用期间切到 `active`，调用结束后恢复原状态。

## 5. 示例

```ts
const runtime = createPetAgentRuntime({
  models,
  actor,
  capabilities,
  toolkits,
  humanReviewer: async (request) => {
    return await uiSession.askReview(request);
  },
});

const result = await runtime.invoke({
  brief: '请给这个产品写一条发布说明',
  wikiRoot: '/abs/path/to/wiki',
  threadId: 'studio:abc:thread:def:pet:pet-a:dispatch:001',
});
```

## 6. 与其他文档关系

1. 运行时边界与 root stream 事件： [PET_AGENT_STUDIO_INTERFACES](PET_AGENT_STUDIO_INTERFACES.md)
2. HITL 细节： [工具事件与 HITL](PET_AGENT_API_EVENTS_HITL.md)
3. Studio 编排层调用方式： [Studio Orchestrator API](PET_AGENT_API_STUDIO_ORCHESTRATOR.md)
4. Capability / Toolkit 组装：
   [Capability / Toolkit V2 契约](PET_AGENT_API_CAPABILITY_TOOLKIT.md)
