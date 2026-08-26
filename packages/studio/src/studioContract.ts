/**
 * Studio 契约。
 *
 * Studio 是一块**插板**:它提供两个方向的通道,不提供任何管理策略。
 *
 *     Plugin A ──notify(event)──> Studio event bus ──subscribe──> Plugin B
 *     Plugin   ──dispatch───────> Studio ──PetDispatchPort──────> Pet
 *
 * - `dispatch` 是 studio 对外的**动作**。所有派活必经它 —— 插件不能绕过
 *   studio 直接碰 pet,否则 pet registry、身份与可派发性判断会在每个插件
 *   里重复一遍,而且多个插件同时派活时没有地方能协调。
 * - `event` 是 studio **接收**的通知,并通过统一 pub/sub 总线广播给其他插件。它是**插件之间的
 *   共享总线** —— 让互不认识的插件能交换信息。
 *
 * Studio 不解释 event 的内容,也不持有由 event 推导出的状态。事件是
 * "发生了什么"(一次性、单向),不是"当前是什么样"(可查询、有生命周期)。
 * 这个区别决定了 studio 不需要存储、不需要一致性、不需要处理并发写。
 *
 * 任务队列、依赖、进度、调度时机、重试 —— 全部属于插件,不属于 studio。
 */

import type { JsonObject } from '@pinpawo/agent-contracts';
import type { AgentToolkit } from '@pinpawo/pet-agent';

import type { StudioPetRegistration } from './types';
import type {
  StudioDispatchReceipt,
  StudioDispatchRequest,
  StudioInvocationEventHandler,
} from './studioInvocation';
export type {
  StudioDispatchReceipt,
  StudioDispatchRequest,
  StudioDispatchResult,
  StudioInvocationEvent,
  StudioInvocationEventHandler,
  StudioInvocationTerminalStatus,
} from './studioInvocation';

/* ─────────────── 入:event ─────────────── */

/**
 * 插件发给 studio 的通知。
 *
 * `type` 由插件自行命名(如 `task.done` / `schedule.fired`),studio
 * **不认识**任何具体类型,只负责广播。`payload` 同理 —— 不解释、不校验。
 *
 * 这样互不认识的插件之间才能交换信息:发布方不需要知道谁在听,订阅方
 * 按自己认识的 type 过滤即可。
 */
export type StudioEvent = {
  type: string;
  /** 发布该 event 的插件名,便于订阅方判断来源。 */
  source: string;
  /** Producer-owned context; Studio does not assign meaning to its fields. */
  metadata?: JsonObject;
  payload?: unknown;
  occurredAt: string;
};

/** 插件发布 event 时只填自己知道的部分;source / occurredAt 由 studio 补齐。 */
export type StudioEventInput = Omit<StudioEvent, 'source' | 'occurredAt'>;

export type StudioEventHandler = (event: StudioEvent) => void | Promise<void>;

export type StudioPluginHookInstaller<T> = (hook: T) => void | (() => void);

/**
 * Opaque Plugin-to-Plugin extension channel. Studio only matches provider,
 * hook name, and lifecycle; it never interprets the hook value.
 */
export type StudioPluginHooks = {
  /** Expose one hook owned by the current Plugin. */
  expose: <T>(name: string, hook: T) => () => void;
  /** Contribute when the named Plugin exposes the hook, in either start order. */
  contribute: <T>(
    targetPluginName: string,
    hookName: string,
    install: StudioPluginHookInstaller<T>,
  ) => () => void;
};

/* ─────────────── 插件 ─────────────── */

/**
 * 插件拿到的 Studio 能力。dispatch/event 是运行通道；hooks 只负责在已安装
 * Plugin 之间装配不透明扩展点，不承载领域事件或执行状态。
 */
export type StudioPluginContext = {
  /** 派活。来源由 studio 补成本插件名,插件不需要(也无法)自报。 */
  dispatch: (input: StudioDispatchRequest) => Promise<StudioDispatchReceipt>;
  /**
   * 订阅**本插件派出去的** invocation 状态。别的插件派的活不会送到这里
   * —— 这是 dispatch 那条点对点的线,不是共享总线。
   *
   * 想听就订,不想听就不订。返回退订函数。
   */
  onInvocation: (handler: StudioInvocationEventHandler) => () => void;
  notify: (event: StudioEventInput) => void;
  subscribe: (handler: StudioEventHandler) => () => void;
  listPets: () => StudioPetRegistration[];
  hooks: StudioPluginHooks;
};

/**
 * Studio 插件 —— 决定"什么时候派谁"，并可为 Agent 定义 Toolkit。
 *
 * kanban(依据任务依赖与进度)、scheduler(依据时间)、trigger(依据外部
 * 事件)都是同级的实现;studio 对它们一视同仁,不为任何一个特殊设计。
 *
 * Plugin 高于 Toolkit，但不是 Toolkit。Plugin 的 Studio lifecycle 使用
 * `StudioPluginContext` 驱动 dispatch/event；它定义的 Toolkit 进入 Host 的
 * Agent Toolkit inventory，由 Capability.uses 在 Agent 侧选择。
 *
 * ```ts
 * const kanbanPlugin: StudioPlugin = {
 *   name: 'kanban',
 *   toolkits: [kanbanToolkit],
 *   start: (ctx) => { ... },
 * };
 * ```
 *
 * Plugin 可以定义零个或多个 Toolkit；`toolkits` 是明确的定义出口，不是把
 * Plugin 伪装成 Toolkit。Capability 完全属于 Agent，不由 Plugin 或 Studio 注册。
 */
export type StudioPlugin = {
  name: string;
  /** Toolkit definitions owned by this Plugin and consumed only by Agent runtimes. */
  toolkits: readonly AgentToolkit[];
  start: (context: StudioPluginContext) => Promise<void> | void;
  stop?: () => Promise<void> | void;
};

/* ─────────────── Studio ─────────────── */

export type Studio = {
  /**
   * 外部输入默认派给谁。曾经有个 `submitRequest(goal)` 包着它 —— 那是多余的:
   * 它完全等价于 `dispatch({ petId: entryPetId, request: goal })`,却让 entry pet
   * 在 API 上有了专属地位。按插板的逻辑,
   * entry pet 只是配置里的一个 pet。
   */
  entryPetId: string;
  dispatch: (input: StudioDispatchRequest) => Promise<StudioDispatchReceipt>;
  /** Host control-plane observation for every Studio invocation. */
  onInvocation: (handler: StudioInvocationEventHandler) => () => void;
  notify: (event: StudioEvent) => void;
  subscribe: (handler: StudioEventHandler) => () => void;
  listPets: () => StudioPetRegistration[];
  shutdown: () => Promise<void>;
};
