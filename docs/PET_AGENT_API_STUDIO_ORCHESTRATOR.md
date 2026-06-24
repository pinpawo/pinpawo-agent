# Studio Orchestrator API

## 1. 入口

```ts
createStudioOrchestrator(config: StudioOrchestratorConfig): StudioOrchestrator
```

## 2. 核心类型

```ts
type StudioOrchestratorConfig = {
  studioId: string;
  ownerUserId: string | null;
  defaultPetId?: string | null;
  agents: PetAgentRuntime[];
  plannerPetId: string;
  wikiBaseDir: string;
  curator?: WikiCurator;
  maxIterationCount?: number;
  maxRetryPerTask?: number;
};

type StudioOrchestrator = {
  context: () => StudioContext;
  listAgents: () => PetAgentRuntimeDescriptor[];
  invoke: (input: StudioOrchestratorInvokeInput) => Promise<StudioTurnResult>;
};

type StudioOrchestratorInvokeInput = {
  userRequest: string;
  plan?: StudioTaskPlan;
  turnId?: string;
  conversationId?: string;
  signal?: AbortSignal;
  onToolEvent?: SubagentToolEventHandler;
  onTurnEvent?: StudioTurnEventHandler;
};
```

## 3. 执行结果

```ts
type StudioTurnResult = {
  turnId: string;
  state: StudioTurnState;
  outcome: 
    | { outcome: 'done'; finalDispatchId: string; reply: string }
    | { outcome: 'stopped'; reason: string; reply: string };
  studio: StudioContext;
};
```

## 4. 关键状态结构

```ts
type StudioTask = {
  petId: string;
  goal: string;
  acceptanceCriteria: string[];
  status: 'pending' | 'satisfied' | 'failed';
  retryCount: number;
};

type StudioDispatchState = {
  id: string;
  taskIndex: number;
  petId: string;
  status: 'running' | 'finished' | 'cancelled';
  brief: string;
  resultText?: string;
  errorMessage?: string;
  startedAt: string;
  finishedAt?: string;
};

type StudioTurnState = {
  turnId: string;
  conversationId: string;
  userRequest: string;
  plan: StudioTaskPlan | null;
  dispatches: StudioDispatchState[];
  wikiRoot: string;
  iterationCount: number;
};
```

## 5. 事件流

```ts
type StudioTurnEvent =
  | { type: 'turn_started'; turnId: string; userRequest: string }
  | { type: 'plan_set'; plan: StudioTaskPlan }
  | { type: 'task_status_changed'; taskIndex: number; status: StudioTaskStatus }
  | { type: 'dispatch_started'; dispatchId: string; taskIndex: number; petId: string }
  | { type: 'dispatch_finished'; dispatchId: string; status: 'finished' | 'cancelled'; resultText?: string; errorMessage?: string; }
  | { type: 'wiki_updated'; changedPaths: string[] }
  | { type: 'turn_finished'; outcome: StudioTurnOutcome };
```

### 5.1 约定

1. 编排内部默认是顺序调度（MVP）。
2. 一次 `invoke` 可以带显式 `plan`，否则走 planner 生成 plan。
3. `onToolEvent` 透传给每次 `pet.invoke()`，用于构建实时工具流。
4. `onTurnEvent` 只表示编排级状态，不代替工具执行事件。

## 6. 示例

```ts
const orchestrator = createStudioOrchestrator({
  studioId: 'studio-demo',
  ownerUserId: null,
  plannerPetId: 'planner',
  wikiBaseDir: '/abs/path/wikis',
  agents: [petA, petB],
});

const result = await orchestrator.invoke({
  userRequest: '请把这次发布文案和视频脚本都补齐',
  onTurnEvent: (event) => ui.renderTurnEvent(event),
  onToolEvent: (event) => ui.renderToolEvent(event),
});
```

## 7. 设计关系

1. 编排状态机与边界规则见 [PET_AGENT_STUDIO_ORCHESTRATOR_DESIGN](PET_AGENT_STUDIO_ORCHESTRATOR_DESIGN.md)
2. 接口边界与数据形状见 [PET_AGENT_STUDIO_INTERFACES](PET_AGENT_STUDIO_INTERFACES.md)
