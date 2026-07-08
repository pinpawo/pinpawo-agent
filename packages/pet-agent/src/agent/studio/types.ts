import type { AgentActor, AgentExecution } from '../../types/agent';
import type { AgentCapability } from '../../types/capability';
import type { AgentToolkit } from '../../types/toolkit';
import type {
  PetAgentCapabilitySummary,
  PetAgentStartupMode,
  PetAgentStatus,
  StudioContext,
} from '../../types/studio';
import type {
  HumanReviewInterruptPayload,
  ReviewResponse,
} from '../orchestrator/review/reviewSpec';

export type HumanReviewerRequest = HumanReviewInterruptPayload;

/**
 * HumanReviewer:pet runtime 在 invoke 期间撞到 HITL interrupt 时回调的桥。
 *
 * pet runtime 不关心上层是 ws / SSE / TUI / 进程内 mock,只承诺:
 * - 给出 canonical `HumanReviewInterruptPayload`
 * - 拿回 canonical `ReviewResponse` 后续跑 graph
 *
 * 上层(chat 层 / 测试)在构造 pet runtime 时注入这个函数,内部自行把
 * request 路由到对应 UI session、等用户答复后 resolve。
 */
export type HumanReviewer = (request: HumanReviewerRequest) => Promise<ReviewResponse>;

/**
 * Pet runtime descriptor — pet agent registry 中暴露的元数据。
 */
export type PetAgentRuntimeDescriptor = AgentActor & {
  role?: string | null;
  serviceSummary?: string | null;
  startupMode: PetAgentStartupMode;
  status: PetAgentStatus;
  capabilities: PetAgentCapabilitySummary[];
};

/**
 * pet runtime 的 invoke 参数。Studio↔pet 边界是函数调用,而非 envelope 协议。
 *
 * - brief: Studio 撰写的任务文本(自然语言),pet 作为唯一输入。
 * - wikiRoot: 共享知识库目录绝对路径。提供时 wiki middleware 会自动读取
 *   {wikiRoot}/index.md 注入到 system prompt,并装备 wiki_read toolkit。
 * - signal: Studio 取消信号。
 * - threadId / execution / workdir: 运行时透传字段。
 * - toolkits: 本次 invoke 临时注入的 toolkit,会与 runtime config toolkits 合并。
 */
export type PetAgentRuntimeInvokeInput = {
  brief: string;
  wikiRoot?: string;
  signal?: AbortSignal;
  threadId?: string;
  execution?: AgentExecution;
  workdir?: string;
  runtimeEnvironment?: string;
  toolkits?: AgentToolkit[];
  /**
   * 调用方在本次 invoke 临时注入的 capability(例如 Studio 给 planner agent 的
   * `studio_plan` capability)。与 runtime 构造时声明的 capability 合并使用。
   */
  extraCapabilities?: AgentCapability[];
  /**
   * 强制以"已发现候选"形态登记到本次 invoke 的 capability 名字列表。
   *
   * 命中后,orchestrator 会在 `capabilitySearch` 阶段把合并后的
   * capability 列表(config.capabilities + extraCapabilities)中同名条目
   * 直接塞进 `runCapabilitySearchState.candidates`,并把 `attempted`
   * 置为 true。`routeDecision` 直接看到强制 capability 作为候选。
   *
   * 典型用途:Studio 调 planner 时强制 `studio_plan` —— 不依赖用户请求文本
   * 与 capability 描述的 keyword 匹配。
   *
   * **不传时,通用 pet agent 走 task-first 的 deterministic capability search。**
   */
  forcedCapabilityNames?: string[];
};

/**
 * pet runtime 的 invoke 返回。一段文本,可包含对文件路径的引用,
 * curator 解析并整理进 wiki。HITL 由 humanReviewer 内部消化,对调用方
 * 不可见——`invoke()` 是原子的,要么 reply,要么抛错。
 */
export type PetAgentRuntimeInvokeResult = {
  reply: string;
};

export type PetAgentRuntime = {
  descriptor: () => PetAgentRuntimeDescriptor;
  invoke: (input: PetAgentRuntimeInvokeInput) => Promise<PetAgentRuntimeInvokeResult>;
};

/* ─────────────── Studio Orchestrator state machine ─────────────── */

export type StudioTaskStatus = 'pending' | 'satisfied' | 'failed';

export type StudioTaskDependencyInput = 'previous' | { taskIndex: number };

export type StudioPlannerTaskInput = {
  petId: string;
  brief: string;
  acceptanceCriteria?: string[];
  deps?: StudioTaskDependencyInput[];
};

/* ─────────────── Studio run queue model ─────────────── */

export type StudioRunStatus =
  | 'planning'
  | 'running'
  | 'blocked'
  | 'done'
  | 'failed'
  | 'cancelled';

export type StudioRun = {
  runId: string;
  conversationId: string;
  userRequest: string;
  status: StudioRunStatus;
  finalTaskIndex?: number;
  finalPetRunId?: string;
  createdAt: string;
  updatedAt: string;
};

export type StudioRunSnapshot = StudioRun & {
  tasks: StudioTaskQueueItem[];
};

export type StudioTaskQueueItem = {
  runId: string;
  conversationId: string;
  taskIndex: number;
  petId: string;
  brief: string;
  acceptanceCriteria: string[];
  deps: number[];
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  petRunId?: string;
  errorMessage?: string;
  enqueuedAt: string;
  startedAt?: string;
  finishedAt?: string;
};

export type StudioQueueItem = StudioTaskQueueItem;

/* ─────────────── Turn outcome (return shape) ─────────────── */

export type StudioTurnOutcome =
  | {
      outcome: 'done';
      finalTaskIndex?: number;
      finalPetRunId?: string;
      reply: string;
    }
  | { outcome: 'stopped'; reason: string; reply: string };

export type StudioTurnResult = {
  turnId: string;
  snapshot: StudioRunSnapshot;
  outcome: StudioTurnOutcome;
  studio: StudioContext;
};

/* ─────────────── Orchestrator entrypoints ─────────────── */

export type StudioSubmitRequestInput = {
  userRequest: string;
  turnId?: string;
  conversationId?: string;
  signal?: AbortSignal;
  /**
   * Studio 编排级事件回调,供控制面状态显示(状态栏 / 徽章 / 进度环)订阅。
   * 来自 Studio 自己(低频、跨 pet 全局编排);pet 内部的工具执行细节不再经
   * 回调透出 — 需要时消费 root `streamEvents(v3)`(#322)。
   */
  onTurnEvent?: StudioTurnEventHandler;
};

export type StudioTurnEventHandler = (event: StudioTurnEvent) => void | Promise<void>;

export type StudioRunEvent =
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

export type StudioRunEventHandler = (event: StudioRunEvent) => void | Promise<void>;

export type StudioSubmitRequestResult = {
  runId: string;
  status: 'accepted';
};

export type StudioOrchestrator = {
  context: () => StudioContext;
  listAgents: () => PetAgentRuntimeDescriptor[];
  submitRequest: (input: StudioSubmitRequestInput) => Promise<StudioSubmitRequestResult>;
  subscribe: (handler: StudioRunEventHandler) => () => void;
  cancelRun: (runId: string) => Promise<void>;
  getRun: (runId: string) => StudioRunSnapshot | null;
  waitForRun: (runId: string) => Promise<StudioTurnResult>;
};

export type StudioOrchestratorConfig = {
  studioId: string;
  ownerUserId: string | null;
  defaultPetId?: string | null;
  agents: PetAgentRuntime[];
  /**
   * 必填:指定哪个 agent 担任 planner。
   * Studio 在 turn 起始用 userRequest invoke 该 agent,并向它注入 `studio_plan`
   * capability。planner agent 通过这个 capability 提交有序 task items。
   */
  plannerPetId: string;
  /**
   * Wiki 根目录的基础路径。runtime 会按 conversationId 拼出
   * `{wikiBaseDir}/conv/{conversationId}/wiki/`。
   */
  wikiBaseDir: string;
  /**
   * Effective host workdir for Studio-dispatched pet invokes.
   */
  workdir?: string;
  /**
   * 可选注入 curator。默认使用 skeleton curator(仅落档原文 + index 追加)。
   * production 建议传入 `createLLMWikiCurator({ models, promptProvider })`,
   * promptProvider 可用 `defaultPromptProvider()` / `fileReadPromptProvider(absPath)`
   * 预设,或传任意 `() => string | Promise<string>` 自定义来源。
   */
  curator?: import('./wikiCurator').WikiCurator;
  /**
   * 可选注入 Studio run/queue store。提供后 orchestrator 会保存 run snapshot,
   * 并在创建时恢复开放 run。due-run scheduler store 不应复用为这个 store。
   */
  runQueueStore?: import('./runQueueStore').StudioRunQueueStore;
  /**
   * 是否在 orchestrator 创建时从 runQueueStore 恢复 open runs。
   * 默认 true。local-agent 这类 per-turn fresh orchestrator 的宿主应在同一
   * process/workdir 内只允许一次恢复,避免多个 live orchestrator 双重驱动同一 run。
   */
  restoreOpenRuns?: boolean;
  /**
   * 单 turn 内 dispatch 累计上限(兜底)。
   */
  maxIterationCount?: number;
  /**
   * 单个 task 的 retry 次数上限。
   */
  maxRetryPerTask?: number;
};

/* ─────────────── Turn state stream events (UI / trace) ─────────────── */

export type StudioTurnEvent =
  | { type: 'turn_started'; turnId: string; userRequest: string }
  | { type: 'tasks_queued'; taskCount: number }
  | { type: 'task_status_changed'; taskIndex: number; status: StudioTaskStatus }
  | { type: 'task_started'; taskIndex: number; petId: string; petRunId: string }
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
  | {
      type: 'turn_finished';
      outcome: 'done' | 'stopped';
      finalPetRunId?: string;
    };

export type StudioRunIdentity = {
  /** 本次 Studio run 的请求 id，通常与 caller 侧 requestId/runId 对齐。 */
  runId: string;
  /** 会话级聚合 id。默认 fallback 到 runId。 */
  conversationId: string;
  /** 用于调度去重。格式: `studio:{conversationId}:run:{runId}`。 */
  idempotencyKey: string;
};

export function buildStudioRunIdentity(input: {
  runId: string;
  conversationId?: string;
}): StudioRunIdentity {
  const conversationId = input.conversationId ?? input.runId;
  return {
    runId: input.runId,
    conversationId,
    idempotencyKey: `studio:${conversationId}:run:${input.runId}`,
  };
}
