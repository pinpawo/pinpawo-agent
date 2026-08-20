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
 * curator 解析并整理进 wiki。`invoke()` 也可能因为 checkpointed interrupt
 * 提前返回；调用方不解释 review payload，只从 gate 观察到 `waiting`。
 */
export type PetAgentRuntimeInvokeResult = {
  reply: string;
};

/**
 * Pet 的闸门状态 —— runtime 对 studio 唯一需要暴露的执行事实。
 *
 * **studio 只关心门开不开**,不关心 pet 在跑模型、在等工具还是在等人。
 * 但门关着的原因分两类,而这个区别对**看的人**是必要的:
 *
 * - `busy` 的队列**在动**,等就行;
 * - `waiting` / `blocked` 的队列**永远不会自己动**,只有人能推动它。
 *
 * 这正是让 §4.2「进度停滞是自明的」成立的东西 —— 一个 pet 卡了两小时,
 * 是在跑大任务、在等人回话,还是砸了没人管,得能一眼看出来。
 *
 * **失败必须停下,不能放行下一条。** 队列里排着的活往往彼此依赖 ——
 * 前一条写文件失败了,后一条接着去改那个文件,那不是"下一个任务失败",
 * 是在一个坏掉的状态上继续操作,破坏性正是这么来的。所以 `blocked`
 * 与 `waiting` 同类:都得人看一眼才继续。
 *
 * 这里没有 `disabled`:那是配置属性,在 `descriptor().startupMode` 里,
 * dispatch 直接拒,不进队列。
 *
 * gate 只服务于**队列放不放行**这一个判断。它是通道自己的机制,不是一份
 * 要广播出去的通知 —— 别把它变成 event。
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
   * 当前闸门状态。studio 的队列据此决定要不要投递下一条。
   *
   * 它**不是** `invoke` 的返回值:pet 撞到人工确认时 `invoke` 会提前返回,
   * 但活并没有干完 —— 门此时是 `waiting` 而非 `open`。把"invoke 返回"当成
   * "派活结束"正是队列失效的根源。
   */
  gate: () => PetGateState;
  /**
   * 订阅闸门变化。studio 在门关着时挂起队列,由这里唤醒 —— 不轮询。
   * 返回退订函数。
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
