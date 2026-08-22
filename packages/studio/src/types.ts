import type { AgentActor, AgentExecution } from '@pinpawo/pet-agent';
import type { AgentCapability } from '@pinpawo/pet-agent';
import type { AgentToolkit } from '@pinpawo/pet-agent';
import type {
  PetAgentCapabilitySummary,
  PetAgentStartupMode,
  PetAgentStatus,
  StudioContext,
} from './petAgentTypes';
import type { ActiveDelegationTransition } from '@pinpawo/pet-agent';
import type {
  PendingInterruptProjection,
  StudioDispatchInput,
} from './studioInvocation';

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
 * - input: 普通请求或显式 interrupt resume。Pet runtime 负责对 checkpoint 校验。
 * - wikiRoot: 共享知识库目录绝对路径。提供时 wiki middleware 会自动读取
 *   {wikiRoot}/index.md 注入到 system prompt,并装备 wiki_read toolkit。
 * - signal: Studio 取消信号。
 * - threadId / execution / workdir: 运行时透传字段。
 * - toolkits: 本次 invoke 临时注入的 toolkit,会与 runtime config toolkits 合并。
 */
export type PetAgentRuntimeInvokeInput = {
  input: StudioDispatchInput;
  threadId: string;
  invocationId: string;
  wikiRoot?: string;
  signal?: AbortSignal;
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
 * pet runtime 的 invoke 返回。一次 graph invocation 要么完成并返回文本,
 * 要么停在已持久化的 interrupt 上并返回公开投射；两者都会结束本次 invocation。
 */
export type PetAgentRuntimeInvokeResult =
  | { status: 'completed'; reply: string }
  | { status: 'pending_interrupt'; pendingInterrupt: PendingInterruptProjection };

/**
 * Pet runtime 的 Host 诊断状态。
 *
 * 门关着的原因分两类,而这个区别对 Host control-plane 的观察者是必要的:
 *
 * - `busy` 的队列**在动**,等就行;
 * - `waiting` / `blocked` 的队列**永远不会自己动**,只有人能推动它。
 *
 * 这正是让 §4.2「进度停滞是自明的」成立的东西 —— 一个 pet 卡了两小时,
 * 是在跑大任务、在等人回话,还是砸了没人管,得能一眼看出来。
 *
 * 这里没有 `disabled`:那是配置属性,在 `descriptor().startupMode` 里,
 * dispatch 直接拒,不进队列。
 *
 * Studio invocation coordinator 不用 gate 延长一次 dispatch：durable interrupt
 * 会结束当前 invocation，后续 typed dispatch 再由 runtime 对 checkpoint 校验。
 */
export type PetGateState =
  /** 空闲,能收下一条派活。 */
  | 'open'
  /** 正在跑(模型 / 工具 / subagent)。它自己会好。 */
  | 'busy'
  /** 停下来等外部输入。只有外部能推动它 —— 卡多久都合理。 */
  | 'waiting'
  /**
   * 上一条派活失败或 pet 声明干不了。**门关着等人**,不自动放行 ——
   * 后面排着的活可能正建立在这条的产出之上。
   */
  | 'blocked';

export type PetAgentRuntime = {
  descriptor: () => PetAgentRuntimeDescriptor;
  invoke: (input: PetAgentRuntimeInvokeInput) => Promise<PetAgentRuntimeInvokeResult>;
  /**
   * 当前 checkpoint/execution 的诊断状态；不是 dispatch 或 invocation identity。
   */
  gate: () => PetGateState;
  /**
   * 订阅诊断状态变化。Studio core 当前不消费它；Host adapter 可以选择投射。
   */
  onGateChange: (listener: (state: PetGateState) => void) => () => void;
  /**
   * Releases Toolkit roots when this runtime created its own manager. A host
   * that supplied toolkitRuntimeManager owns the shared lifecycle instead.
   */
  shutdown?: () => Promise<void>;
};

/*
 * run / task / 依赖 / 进度 / 重试 的类型曾经住在这里。它们**全部属于插件**
 * (设计 §5)—— studio 甚至不需要知道 "run" 这个词,已随旧 orchestrator
 * 一并迁出。看板的领域模型见 `@pinpawo-toolkit/studio-kanban`。
 */
