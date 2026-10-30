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
 *   里重复一遍。Studio 只完成 target 选择与 admission identity；多个输入的
 *   queue/gate 协调由 `PetDispatchPort` 后面的 resident runtime 负责。
 * - `event` 是 studio **接收**的通知,并通过统一 pub/sub 总线广播给其他插件。它是**插件之间的
 *   共享总线** —— 让互不认识的插件能交换信息。
 *
 * Studio 不解释 event 的内容,也不持有由 event 推导出的状态。事件是
 * "发生了什么"(一次性、单向),不是"当前是什么样"(可查询、有生命周期)。
 * 这个区别决定了 studio 不存由 event 推导出的状态;它自己只存客户身份和 Pet
 * 实例。插件的数据放在 Studio 提供的一个共享数据库里(`storage`),表和迁移
 * 归各插件所有,studio 只负责打开、迁移与关闭。
 *
 * 任务队列、依赖、进度、调度时机、重试 —— 全部属于插件,不属于 studio。
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { JsonObject } from '@pinpawo/agent-contracts';
import type { AgentToolkit } from '@pinpawo/pet-agent';

import type { StudioPetRegistration } from './types';
import type { StudioPets } from './pets/studioPets';
import type { StudioPluginStorage } from './storage/studioStorage';
import type { StudioClients } from './clients/studioClients';
import type {
  StudioDispatchReceipt,
  StudioDispatchRequest,
} from './studioInvocation';
export type {
  StudioDispatchReceipt,
  StudioDispatchRequest,
} from './studioInvocation';

/* ─────────────── 入:event ─────────────── */

/**
 * 插件发给 studio 的通知。
 *
 * `type` 通常由插件命名(如 `task.done` / `schedule.fired`),studio
 * **不认识**插件类型,只负责广播。Studio core 仅发布自己的边界事实，例如
 * `dispatch.accepted`；它同样不表示 Agent 执行完成。所有 Plugin 启动完成后，core 发布一次
 * `plugins.activated`，依赖其他 Plugin hook 的工作可以等它再开始。`payload` 不被总线解释或校验。
 *
 * 这样互不认识的插件之间才能交换信息:发布方不需要知道谁在听,订阅方
 * 按自己认识的 type 过滤即可。
 */
export type StudioEvent = {
  /** Studio 在发布时为每个 event 分配的唯一 id;同一个 event 交给多个订阅者时不变。 */
  eventId: string;
  type: string;
  /** 发布该 event 的插件名，或 `studio` 这一 core producer。 */
  source: string;
  /** Producer-owned context; Studio does not assign meaning to its fields. */
  metadata?: JsonObject;
  payload?: unknown;
  occurredAt: string;
};

/** 插件发布 event 时只填自己知道的部分;eventId / source / occurredAt 由 studio 补齐。 */
export type StudioEventInput = Omit<StudioEvent, 'eventId' | 'source' | 'occurredAt'>;

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
  /** 单向派活。Promise 只覆盖 Studio/Pet 的接纳，不代表 Agent 执行完成。 */
  dispatch: (input: StudioDispatchRequest) => Promise<StudioDispatchReceipt>;
  /**
   * A new session id for `dispatch({ session: { id, create: true } })`.
   * It only reserves the name: nothing is created or selected until dispatch.
   */
  allocateSessionId: (petId: string) => string;
  notify: (event: StudioEventInput) => void;
  /** Studio 会在本 Plugin 停止时自动退订；返回值用于提前停止接收。 */
  subscribe: (handler: StudioEventHandler) => () => void;
  /** The live Pets. */
  listPets: () => StudioPetRegistration[];
  /** Create and rename Pets, and read their records. */
  pets: StudioPets;
  /**
   * Read current resident dispatch-queue snapshots. This is observation only:
   * Studio neither stores them nor decides how a queue should progress.
   */
  listDispatchQueues: () => StudioDispatchQueue[];
  /**
   * Read, follow, and answer the current review of one exact Pet session.
   * Borrowed from the Pet's Host: Studio adds Pet routing and nothing else.
   */
  petSessions: StudioPetSessions;
  hooks: StudioPluginHooks;
  /**
   * The Studio database. `open(migrations)` applies this Plugin's pending
   * migrations and returns the shared Kysely instance; the Plugin owns its
   * tables (prefixed with its name) and never touches another Plugin's.
   * Studio closes it after every Plugin has stopped.
   */
  storage: StudioPluginStorage;
  /**
   * Who may connect to this Studio. Studio keeps the identities; the HTTP
   * Plugin authenticates requests with them and other Plugins read labels.
   */
  clients: StudioClients;
  /**
   * The Host's model profiles, read only. A Plugin that makes its own model
   * call (not a Pet run) names a profile instead of keeping its own key.
   */
  models: StudioModels;
};

/** A Host model endpoint; consumers must check which protocols they support. */
export type StudioModelEndpoint = {
  /** Omission preserves the legacy OpenAI-compatible transport. */
  protocol?: 'openai-compatible' | 'anthropic-compatible';
  profileId: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Routing defaults to legacy jsonMode; native custom resolvers should set their supported method. */
  structuredOutputMethod?: 'functionCalling' | 'jsonMode' | 'jsonSchema';
  /** Creates a model from the complete Host-resolved profile. */
  createChatModel?: (options: {
    maxOutputTokens: number;
    maxRetries: number;
    preferDeterministic: boolean;
    streaming?: boolean;
    forceChatCompletions?: boolean;
  }) => BaseChatModel;
};
export type StudioModels = {
  /** The named profile, or the Host default; throws for an unknown profile or when the Studio has none. */
  resolve: (profileId?: string) => StudioModelEndpoint;
};

type PetSessionPort = import('pinpawo/host-runtime').PetSessionPort;

/**
 * Exact-session access to resident Pets. A Pet that is not registered, or
 * whose Host offers no session port, rejects with `pet_unavailable`; an
 * unknown session rejects with `session_not_found`. Neither ever falls back
 * to another Pet or to an active session.
 */
export type StudioPetSessions = {
  snapshot: (petId: string, ...args: Parameters<PetSessionPort['snapshot']>) => ReturnType<PetSessionPort['snapshot']>;
  observe: (petId: string, ...args: Parameters<PetSessionPort['observe']>) => ReturnType<PetSessionPort['observe']>;
  review: (petId: string, ...args: Parameters<PetSessionPort['review']>) => ReturnType<PetSessionPort['review']>;
};

export class StudioPetUnavailableError extends Error {
  readonly code = 'pet_unavailable';

  constructor(petId: string) {
    super(`Pet "${petId}" is not available for session access.`);
    this.name = 'StudioPetUnavailableError';
  }
}

/** Read-only projection of one resident Pet's dispatch-admission queue. */
export type StudioDispatchQueue = {
  petId: string;
  state: 'open' | 'busy' | 'waiting' | 'blocked';
  activeOperation: 'conversation' | 'dispatch' | null;
  queuedConversations: number;
  queuedDispatches: number;
  entries?: import('pinpawo/host-runtime').PetDispatchQueueEntry[];
  activeDispatch?: import('pinpawo/host-runtime').PetDispatchQueueEntry;
};

/**
 * Studio 插件 —— 决定"什么时候派谁"，并可为 Agent 定义 Toolkit。
 *
 * channel(显式目标与公开结果)、scheduler(依据时间)、trigger(依据外部
 * 事件)都是同级的实现;studio 对它们一视同仁,不为任何一个特殊设计。
 *
 * Plugin 高于 Toolkit，但不是 Toolkit。Plugin 的 Studio lifecycle 使用
 * `StudioPluginContext` 驱动 dispatch/event；它定义的 Toolkit 进入 Host 的
 * Agent Toolkit inventory，由 Capability.uses 在 Agent 侧选择。
 *
 * ```ts
 * const channelPlugin: StudioPlugin = {
 *   name: 'channel',
 *   toolkits: [channelToolkit],
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
  dispatch: (input: StudioDispatchRequest) => Promise<StudioDispatchReceipt>;
  /** eventId 省略时由 studio 分配。 */
  notify: (event: Omit<StudioEvent, 'eventId'> & { eventId?: string }) => void;
  subscribe: (handler: StudioEventHandler) => () => void;
  listPets: () => StudioPetRegistration[];
  pets: StudioPets;
  shutdown: () => Promise<void>;
};
