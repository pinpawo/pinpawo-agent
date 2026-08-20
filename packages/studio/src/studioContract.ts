/**
 * Studio 契约。
 *
 * Studio 是一块**插板**:它提供两个方向的通道,不提供任何管理策略。
 *
 *     plugin ──event────> studio ──dispatch──> pet
 *
 * - `dispatch` 是 studio 对外的**动作**。所有派活必经它 —— 插件不能绕过
 *   studio 直接碰 pet,否则 pet registry、身份与可派发性判断会在每个插件
 *   里重复一遍,而且多个插件同时派活时没有地方能协调。
 * - `event` 是 studio **接收**的通知,并广播给其他插件。它是**插件之间的
 *   共享总线** —— 让互不认识的插件能交换信息。
 *
 * Studio 不解释 event 的内容,也不持有由 event 推导出的状态。事件是
 * "发生了什么"(一次性、单向),不是"当前是什么样"(可查询、有生命周期)。
 * 这个区别决定了 studio 不需要存储、不需要一致性、不需要处理并发写。
 *
 * 任务队列、依赖、进度、调度时机、重试 —— 全部属于插件,不属于 studio。
 */

import type { AgentToolkit } from '@pinpawo/pet-agent';

import type { PetAgentRuntimeDescriptor, PetGateState } from './types';

/* ─────────────── 出:dispatch ─────────────── */

/**
 * 一次派活。**这是 studio 唯一的对外动作。**
 *
 * `request` 是自然语言 —— studio 不定义任务结构,那是插件的事。
 */
export type StudioDispatchInput = {
  petId: string;
  request: string;
  /**
   * 发起方自己的关联标识,studio **原样透传**不解释。插件用它把后续
   * event 与这次 dispatch 对上;不同插件可以有完全不同的编码方式。
   */
  correlationId?: string;
  signal?: AbortSignal;
};

/**
 * dispatch 的返回。
 *
 * **它只表示"已经发出去了",不表示任务完成。** pet 干完之后自己经由
 * toolkit → 插件 → event 汇报,不通过这个返回值。
 *
 * 因此这里没有 reply、没有成功失败判定 —— studio 对结果不做任何解释。
 */
export type StudioDispatchResult = {
  /**
   * pet 执行落在哪个 thread 上。它同时充当这次 dispatch 的标识 ——
   * thread 本来就唯一,再发一个 dispatchId 只是同义词。
   */
  threadId: string;
};

/**
 * 一次派活的闸门变化。
 *
 * **它沿 dispatch 那条线回到发起方,不走 event 总线。** 派活是点对点的,
 * 它的进展也是 —— "你派的那条活现在怎么样"是发起方与 studio 之间的事,
 * 与别的插件无关。
 *
 * 这条边界要守住:`event` 只承载"某个插件宣布发生了什么"。把通道自己的
 * 机制反馈也塞进去,event 会慢慢变成万能管道,定义随之失效。
 */
export type StudioDispatchGateChange = {
  /** 哪次 dispatch —— 与 `StudioDispatchResult.threadId` 同一个值。 */
  threadId: string;
  petId: string;
  /** 发起方自己的关联标识,原样带回。 */
  correlationId?: string;
  state: PetGateState;
};

export type StudioDispatchGateHandler =
  (change: StudioDispatchGateChange) => void | Promise<void>;

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
  /** 若该 event 源于某次 dispatch,带上它的 correlationId。 */
  correlationId?: string;
  payload?: unknown;
  occurredAt: string;
};

/** 插件发布 event 时只填自己知道的部分;source / occurredAt 由 studio 补齐。 */
export type StudioEventInput = Omit<StudioEvent, 'source' | 'occurredAt'>;

export type StudioEventHandler = (event: StudioEvent) => void | Promise<void>;

/* ─────────────── 插件 ─────────────── */

/**
 * 插件拿到的 studio 能力。它只能做两件事:派活、发通知。
 */
export type StudioPluginContext = {
  /** 派活。来源由 studio 补成本插件名,插件不需要(也无法)自报。 */
  dispatch: (input: StudioDispatchInput) => Promise<StudioDispatchResult>;
  /**
   * 订阅**本插件派出去的**那些 dispatch 的闸门变化。别的插件派的活不会
   * 送到这里 —— 这是 dispatch 那条点对点的线,不是共享总线。
   *
   * 想听就订,不想听就不订。返回退订函数。
   */
  onDispatchGate: (handler: StudioDispatchGateHandler) => () => void;
  notify: (event: StudioEventInput) => void;
  subscribe: (handler: StudioEventHandler) => () => void;
  listPets: () => PetAgentRuntimeDescriptor[];
};

/**
 * layout 插件 —— 决定"什么时候派谁"。
 *
 * kanban(依据任务依赖与进度)、scheduler(依据时间)、trigger(依据外部
 * 事件)都是同级的实现;studio 对它们一视同仁,不为任何一个特殊设计。
 *
 * **结构上它就是一个 `AgentToolkit`,外加一个 `studio` 字段。**
 * 这样现有 toolkit 变成插件只需补一个字段,不必重写:
 *
 * ```ts
 * const kanbanPlugin: StudioPlugin = {
 *   ...existingKanbanToolkit,          // 原样复用
 *   studio: { start: (ctx) => { ... } } // 只补这一段
 * };
 * ```
 *
 * 两副面孔由此自然成立:作为 toolkit 绑在 pet 上(pet 读写它的领域数据),
 * 作为插件插在 studio 上(委托 dispatch、发 event)。pet 调 toolkit →
 * toolkit 触发插件内部状态 → 插件发 event,闭环不经过 studio 解释内容。
 *
 * `studio` 省略时它就是个普通 toolkit;`tools` 为空时它就是个纯驱动方。
 * 两者都合法 —— 插件不必同时具备两副面孔。
 */
export type StudioPlugin = AgentToolkit & {
  studio?: {
    start: (context: StudioPluginContext) => Promise<void> | void;
    stop?: () => Promise<void> | void;
  };
};

/* ─────────────── Studio ─────────────── */

export type Studio = {
  /**
   * 外部输入默认派给谁。曾经有个 `submitRequest(goal)` 包着它 —— 那是多余的:
   * 它完全等价于 `dispatch({ petId: entryPetId, request: goal })`,却让 entry pet
   * 在 API 上有了专属地位。按插板的逻辑,entry pet 只是配置里的一个 pet。
   */
  entryPetId: string;
  dispatch: (input: StudioDispatchInput) => Promise<StudioDispatchResult>;
  /**
   * 订阅所有 dispatch 的闸门变化，包括宿主直接发起的 dispatch。
   *
   * 插件仍应优先使用 `StudioPluginContext.onDispatchGate`，因为那条订阅只会
   * 收到插件自己的派活。这个全局入口属于 Host 控制面，用于把状态投射给
   * 发起请求的 transport，并在 dispatch 结束后释放关联关系。
   */
  onDispatchGate: (handler: StudioDispatchGateHandler) => () => void;
  notify: (event: StudioEvent) => void;
  subscribe: (handler: StudioEventHandler) => () => void;
  listPets: () => PetAgentRuntimeDescriptor[];
  shutdown: () => Promise<void>;
};
