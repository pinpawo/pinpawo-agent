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

/*
 * run / task / 依赖 / 进度 / 重试 的类型曾经住在这里。它们**全部属于插件**
 * (设计 §5)—— studio 甚至不需要知道 "run" 这个词,已随旧 orchestrator
 * 一并迁出。看板的领域模型见 `@pinpawo-toolkit/studio-kanban`。
 */
