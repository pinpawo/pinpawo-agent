import type { AgentActor, AgentExecution } from '@pinpawo/pet-agent';
import type { AgentCapability } from '@pinpawo/pet-agent';
import type { AgentToolkit } from '@pinpawo/pet-agent';
import type {
  PetAgentCapabilitySummary,
  PetAgentStartupMode,
  PetAgentStatus,
  StudioContext,
} from './petAgentTypes';
import type {
  HumanReviewInterruptPayload,
  ReviewResponse,
} from '@pinpawo/pet-agent';
import type { ActiveDelegationTransition } from '@pinpawo/pet-agent';

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
   * 本次 invoke 的 Capability allowlist。Capability Planner 的只读文档
   * workspace 只物化这些已编译、可用的 Capability；不传时暴露完整 registry。
   */
  allowedCapabilityNames?: string[];
  activeDelegationTransition?: ActiveDelegationTransition;
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
  /**
   * Releases Toolkit roots when this runtime created its own manager. A host
   * that supplied toolkitRuntimeManager owns the shared lifecycle instead.
   */
  shutdown?: () => Promise<void>;
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
  /** 产出最终结果的那次调度。 */
  finalInvocationId?: string;
  createdAt: string;
  updatedAt: string;
};

export type StudioRunSnapshot = StudioRun & {
  tasks: StudioTaskQueueItem[];
};

/**
 * 一次 pet 调度尝试。
 *
 * task 与 invocation 分开是因为它们的生命周期不同:task 是"要做的事",
 * 重试后仍是同一个 task;invocation 是"做这件事的某一次尝试",每次重试
 * 都是新的一次。取消、事件路由和 lease 都作用在 invocation 上,这样取消
 * 一次尝试不会误伤同 task 的其他尝试。
 */
export type StudioInvocation = {
  invocationId: string;
  petId: string;
  /** 同一 task 内从 0 递增。**持久化**,否则崩溃恢复后重试次数归零。 */
  attempt: number;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt?: string;
  errorMessage?: string;
};

export type StudioTaskQueueItem = {
  runId: string;
  conversationId: string;
  /**
   * 稳定标识。`taskIndex` 是展示序号,re-plan 后会变;需要寻址某个 task
   * (取消、事件关联)时用 `taskId`。
   */
  taskId: string;
  taskIndex: number;
  petId: string;
  brief: string;
  acceptanceCriteria: string[];
  deps: number[];
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  /**
   * 该 task 的历次调度尝试,按 attempt 升序。空数组表示尚未派发过。
   * 重试计数由 `invocations.length` 导出,不再单独存一个易漂移的字段。
   */
  invocations: StudioInvocation[];
  errorMessage?: string;
  enqueuedAt: string;
  startedAt?: string;
  finishedAt?: string;
};

/** 最近一次调度尝试;未派发过时为 undefined。 */
export function latestInvocation(task: StudioTaskQueueItem): StudioInvocation | undefined {
  return task.invocations.at(-1);
}

/**
 * 已消耗的重试次数 = 已失败的尝试数。
 *
 * 从持久化的 invocation 列表导出,因此崩溃恢复后仍然准确 —— 这正是
 * 独立 `retryCount` 字段做不到的。
 */
export function failedAttemptCount(task: StudioTaskQueueItem): number {
  return task.invocations.filter((invocation) => invocation.status === 'failed').length;
}

export type StudioQueueItem = StudioTaskQueueItem;

/* ─────────────── Turn outcome (return shape) ─────────────── */

export type StudioTurnOutcome =
  | {
      outcome: 'done';
      finalTaskIndex?: number;
      finalInvocationId?: string;
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
   * 可选注入 curator。默认 no-op(不落盘);宿主注入真正的实现。
   * production 建议传入 `createLLMWikiCurator({ models, promptProvider })`,
   * promptProvider 可用 `defaultPromptProvider()` / `fileReadPromptProvider(absPath)`
   * 预设,或传任意 `() => string | Promise<string>` 自定义来源。
   */
  curator?: import('./wikiPort').WikiCurator;
  /**
   * 可选注入:开 run 前初始化 wiki 存储骨架。默认 no-op,由宿主注入实现。
   */
  ensureWikiSkeleton?: import('./wikiPort').WikiSkeletonInitializer;
  /**
   * 可选注入 Studio run/queue store。提供后 orchestrator 会保存 run snapshot,
   * 并在创建时恢复开放 run。due-run scheduler store 不应复用为这个 store。
   */
  runQueueStore?: import('./runQueuePort').StudioRunQueueStore;
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
  | { type: 'task_started'; taskIndex: number; petId: string; invocationId: string }
  | {
      type: 'task_finished';
      taskIndex: number;
      petId: string;
      invocationId: string;
      status: 'finished' | 'cancelled';
      resultText?: string;
      errorMessage?: string;
    }
  | { type: 'wiki_updated'; changedPaths: string[] }
  | {
      type: 'turn_finished';
      outcome: 'done' | 'stopped';
      finalInvocationId?: string;
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
