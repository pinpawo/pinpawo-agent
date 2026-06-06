import type { AgentActor, AgentExecution } from '../../types/agent';
import type { AgentCapability } from '../../types/capability';
import type { ToolkitOperationMetadata } from '../../types/toolkit';
import type {
  PetAgentCapabilitySummary,
  PetAgentStartupMode,
  PetAgentStatus,
  StudioContext,
} from '../../types/studio';
import type { SubagentToolEventHandler } from '../../types/subagent';
import type { HumanReviewDecision, HumanReviewRequest } from '../orchestrator/humanReview';

/**
 * HumanReviewer:pet runtime 在 invoke 期间撞到 HITL interrupt 时回调的桥。
 *
 * pet runtime 不关心上层是 ws / SSE / TUI / 进程内 mock,只承诺:
 * - 给出 `HumanReviewRequest`
 * - 拿回 `HumanReviewDecision` 后续跑 graph
 *
 * 上层(chat 层 / 测试)在构造 pet runtime 时注入这个函数,内部自行把
 * request 路由到对应 UI session、等用户答复后 resolve。
 */
export type HumanReviewer = (request: HumanReviewRequest) => Promise<HumanReviewDecision>;

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
 * - threadId / execution / workdir / onToolEvent: 运行时透传字段。
 */
export type PetAgentRuntimeInvokeInput = {
  brief: string;
  wikiRoot?: string;
  signal?: AbortSignal;
  threadId?: string;
  execution?: AgentExecution;
  workdir?: string;
  runtimeEnvironment?: string;
  onToolEvent?: SubagentToolEventHandler;
  /**
   * 本次 invoke 临时注入的 host/global tools 展示 metadata。
   * 这些 tools 不属于 toolkit/capability runtime 时,由调用方通过这里声明 operation 语义。
   *
   * @deprecated 迁移期 fallback。新代码应优先通过 toolkit/toolset 暴露 operation metadata。
   */
  toolOperations?: Record<string, ToolkitOperationMetadata>;
  /**
   * 调用方在本次 invoke 临时注入的 capability(例如 Studio 给 planner agent 的
   * `studio_plan` capability)。与 runtime 构造时声明的 capability 合并使用。
   */
  extraCapabilities?: AgentCapability[];
  /**
   * 强制以"已发现候选"形态登记到本次 invoke 的 capability 名字列表。
   *
   * 命中后,orchestrator 会在 `prepare` 阶段把合并后的 capability 列表
   * (config.capabilities + extraCapabilities)中同名条目直接塞进
   * `capabilitySearchState.candidates`,并把 `attempted` 置为 true →
   * `capabilityDiscovery` 节点里的 LLM 调用会被短路,`capabilitySearch`
   * 工具节点不会被路由。`userIntentDecision` 直接看到强制 capability
   * 作为候选。
   *
   * 典型用途:Studio 调 planner 时强制 `studio_plan` —— 不依赖用户请求文本
   * 与 capability 描述的 keyword 匹配。
   *
   * **不传时,通用 pet agent 的 capability 发现/搜索流程 0 行为变化。**
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

export type StudioTask = {
  petId: string;
  goal: string;
  acceptanceCriteria: string[];
  status: StudioTaskStatus;
  retryCount: number;
};

export type StudioTaskPlan = {
  tasks: StudioTask[]; // 顺序即执行顺序;index 即 task 身份
};

export type StudioDispatchStatus = 'running' | 'finished' | 'cancelled';

export type StudioDispatchState = {
  id: string;
  /** 对应 plan.tasks 中的下标 */
  taskIndex: number;
  petId: string;
  status: StudioDispatchStatus;
  brief: string;
  resultText?: string;
  errorMessage?: string;
  startedAt: string;
  finishedAt?: string;
};

export type StudioTurnState = {
  turnId: string;
  conversationId: string;
  userRequest: string;
  plan: StudioTaskPlan | null;
  dispatches: StudioDispatchState[];
  wikiRoot: string;
  iterationCount: number;
};

/* ─────────────── Execute action(留作内部状态机文档) ─────────────── */

export type ExecuteAction =
  | { type: 'dispatch'; taskIndex: number; brief: string }
  | { type: 'finish'; finalDispatchId: string }
  | { type: 'stop'; reason: string };

/* ─────────────── Turn outcome (return shape) ─────────────── */

export type StudioTurnOutcome =
  | { outcome: 'done'; finalDispatchId: string; reply: string }
  | { outcome: 'stopped'; reason: string; reply: string };

export type StudioTurnResult = {
  turnId: string;
  state: StudioTurnState;
  outcome: StudioTurnOutcome;
  studio: StudioContext;
};

/* ─────────────── Orchestrator entrypoints ─────────────── */

/**
 * 显式 plan 入口(Phase 1 skeleton 使用)。后续 LLM-driven planner 落地后,
 * 这条入口仍保留作为调试/测试用。
 */
export type StudioOrchestratorInvokeInput = {
  userRequest: string;
  plan?: StudioTaskPlan;
  turnId?: string;
  conversationId?: string;
  signal?: AbortSignal;
  /**
   * 透传给每次 `pet.invoke()`(planner 与 dispatch pet 都会收到)。
   * Studio 自身不消费内容,只把工具事件转给 UI 渲染。
   */
  onToolEvent?: SubagentToolEventHandler;
  /**
   * Studio 编排级事件回调,供控制面状态显示(状态栏 / 徽章 / 进度环)订阅。
   * 与 `onToolEvent` 是两条独立的流:onToolEvent 来自 pet runtime 内部 tool 节点
   * (高频、贴近 pet 工作现场),onTurnEvent 来自 Studio 自己(低频、跨 pet 全局编排)。
   */
  onTurnEvent?: StudioTurnEventHandler;
};

export type StudioTurnEventHandler = (event: StudioTurnEvent) => void | Promise<void>;

export type StudioOrchestrator = {
  context: () => StudioContext;
  listAgents: () => PetAgentRuntimeDescriptor[];
  invoke: (input: StudioOrchestratorInvokeInput) => Promise<StudioTurnResult>;
};

export type StudioOrchestratorConfig = {
  studioId: string;
  ownerUserId: string | null;
  defaultPetId?: string | null;
  agents: PetAgentRuntime[];
  /**
   * 必填:指定哪个 agent 担任 planner。
   * Studio 在 turn 起始用 userRequest invoke 该 agent,并向它注入 `studio_plan`
   * capability。planner agent 通过这个 capability 提交结构化 plan。
   */
  plannerPetId: string;
  /**
   * Wiki 根目录的基础路径。runtime 会按 conversationId 拼出
   * `{wikiBaseDir}/conv/{conversationId}/wiki/`。
   */
  wikiBaseDir: string;
  /**
   * 可选注入 curator。默认使用 skeleton curator(仅落档原文 + index 追加)。
   * production 建议传入 `createLLMWikiCurator({ models, promptProvider })`,
   * promptProvider 可用 `defaultPromptProvider()` / `fileReadPromptProvider(absPath)`
   * 预设,或传任意 `() => string | Promise<string>` 自定义来源。
   */
  curator?: import('./wikiCurator').WikiCurator;
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
  | { type: 'plan_set'; plan: StudioTaskPlan }
  | { type: 'task_status_changed'; taskIndex: number; status: StudioTaskStatus }
  | { type: 'dispatch_started'; dispatchId: string; taskIndex: number; petId: string }
  | {
      type: 'dispatch_finished';
      dispatchId: string;
      status: 'finished' | 'cancelled';
      resultText?: string;
      errorMessage?: string;
    }
  | { type: 'wiki_updated'; changedPaths: string[] }
  | {
      type: 'turn_finished';
      outcome: 'done' | 'stopped';
      finalDispatchId?: string;
    };
