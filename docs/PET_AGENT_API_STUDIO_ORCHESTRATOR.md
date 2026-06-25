# Studio Orchestrator API

## 1. 入口

```ts
createStudioOrchestrator(config: StudioOrchestratorConfig): StudioOrchestrator
```

## 2. 运行时类型（核心）

```ts
type StudioOrchestrator = {
  context: () => StudioContext;
  listAgents: () => PetAgentRuntimeDescriptor[];
  submitRequest: (input: StudioSubmitRequestInput) => Promise<StudioSubmitRequestResult>;
  subscribe: (handler: StudioRunEventHandler) => () => void;
  cancelRun: (runId: string) => Promise<void>;
  getRun: (runId: string) => StudioRunSnapshot | null;
  waitForRun: (runId: string) => Promise<StudioTurnResult>;
};

type StudioSubmitRequestInput = {
  userRequest: string;
  turnId?: string;
  conversationId?: string;
  signal?: AbortSignal;
  onToolEvent?: SubagentToolEventHandler;
  onTurnEvent?: StudioTurnEventHandler;
};

type StudioSubmitRequestResult = {
  runId: string;
  status: 'accepted';
};

type StudioTurnResult = {
  turnId: string;
  snapshot: StudioRunSnapshot;
  outcome: StudioTurnOutcome;
  studio: StudioContext;
};

type StudioTurnOutcome =
  | {
      outcome: 'done';
      finalTaskIndex?: number;
      finalPetRunId?: string;
      reply: string;
    }
  | { outcome: 'stopped'; reason: string; reply: string };
```

`submitRequest` 是异步入列入口；`waitForRun` 阻塞等待该 run 的终态。

## 3. 配置

```ts
type StudioOrchestratorConfig = {
  studioId: string;
  ownerUserId: string | null;
  agents: PetAgentRuntime[];
  plannerPetId: string;
  wikiBaseDir: string;
  defaultPetId?: string | null;
  curator?: WikiCurator;
  runQueueStore?: import('./runQueueStore').StudioRunQueueStore;
  restoreOpenRuns?: boolean;
  workdir?: string;
  maxIterationCount?: number;
  maxRetryPerTask?: number;
};
```

要点:

- 仍按 agent registry 创建可调度 pet 列表。
- `plannerPetId` 指定的 pet 在 turn 起始负责 plan。
- `restoreOpenRuns` 为 true 时会从 store 恢复未完成 run。

## 4. 事件流

```ts
type StudioTurnEvent =
  | { type: 'turn_started'; turnId: string; userRequest: string }
  | { type: 'tasks_queued'; taskCount: number }
  | { type: 'task_status_changed'; taskIndex: number; status: StudioTaskStatus }
  | {
      type: 'task_started';
      taskIndex: number;
      petId: string;
      petRunId: string;
    }
  | {
      type: 'task_finished';
      taskIndex: number;
      petId: string;
      petRunId: string;
      status: 'finished' | 'cancelled';
      resultText?: string;
      errorMessage?: string;
    }
  | { type: 'wiki_updated'; changedPaths: string[] }
  | { type: 'turn_finished'; outcome: 'done' | 'stopped'; finalPetRunId?: string };

type StudioRunEvent =
  | {
      type: 'run_changed';
      runId: string;
      conversationId: string;
      status: StudioRunStatus;
      snapshot: StudioRunSnapshot;
      reason?: string;
      occurredAt: string;
    }
  | {
      type: 'wiki_changed';
      runId: string;
      conversationId: string;
      changedPaths: string[];
      occurredAt: string;
    };
```

- `onTurnEvent`：编排级低频事件，适合控制面。
- `onToolEvent`：高频工具事件，适合 pet 面板。
- `subscribe` 关注 run 级快照变更；`onTurnEvent` 关注状态机阶段。

## 5. 任务模型与完成身份

`StudioTaskQueueItem` 是 run queue 的执行单元，包含 `petRunId`。

`StudioTurnOutcome.finalPetRunId` 是真正的完成身份（用于 trace 与重入）。
`finalDispatchId` 为持久化兼容字段，只用于旧数据回填，不作为新文档核心术语。

## 6. 使用示例

```ts
const orchestrator = createStudioOrchestrator({
  studioId: 'studio-demo',
  ownerUserId: null,
  plannerPetId: 'planner',
  wikiBaseDir: '/abs/path/wikis',
  agents: [petA, petB],
});

const accepted = await orchestrator.submitRequest({
  userRequest: '先产出文案，再补齐视频脚本。',
  onTurnEvent: (event) => ui.renderTurnEvent(event),
  onToolEvent: (event) => ui.renderToolEvent(event),
});

const result = await orchestrator.waitForRun(accepted.runId);
console.log(result.outcome.finalPetRunId, result.outcome.reply);
```

## 7. 相关文档

- `docs/PET_AGENT_STUDIO_INTERFACES.md`
- `docs/PET_AGENT_CAPABILITY_ARTIFACT_STORE_DESIGN.md`
- `packages/pet-agent/src/agent/studio/types.ts`
