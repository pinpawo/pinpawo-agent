import { randomUUID } from 'node:crypto';

import type {
  Studio,
  StudioDispatchGateChange,
  StudioDispatchGateHandler,
  StudioDispatchInput,
  StudioDispatchResult,
  StudioEvent,
  StudioEventHandler,
  StudioEventInput,
  StudioPlugin,
  StudioPluginContext,
} from './studioContract';
import type { PetAgentRuntime, PetAgentRuntimeDescriptor, PetGateState } from './types';

export type CreateStudioInput = {
  studioId: string;
  /** 本 studio 可派活的 pet。 */
  pets: PetAgentRuntime[];
  /** 外部输入默认派给谁;必须在 `pets` 中。 */
  entryPetId: string;
  /** 装哪些插件。顺序即 start 顺序。 */
  plugins?: StudioPlugin[];
};

/**
 * 创建一块 studio 插板。
 *
 * 它只做三件事:持有 pet registry、提供 `dispatch` 出口、维护 `event` 总线。
 * 任务队列、依赖、进度、调度时机、重试全部属于插件 —— studio 不认识它们,
 * 也不持有由 event 推导出的任何状态。
 */
export async function createStudio(input: CreateStudioInput): Promise<Studio> {
  const petsById = new Map<string, PetAgentRuntime>();
  for (const pet of input.pets) {
    const { petId } = pet.descriptor();
    if (petsById.has(petId)) {
      throw new Error(`studio "${input.studioId}": duplicate petId "${petId}"`);
    }
    petsById.set(petId, pet);
  }
  if (!petsById.has(input.entryPetId)) {
    throw new Error(
      `studio "${input.studioId}": entryPetId "${input.entryPetId}" is not among the configured pets`,
    );
  }

  const plugins = input.plugins ?? [];
  const handlers = new Set<StudioEventHandler>();
  let stopped = false;

  /**
   * 每个插件订阅的 dispatch 闸门回调。按插件分组存放,`stop` 时整组清掉 ——
   * 插件停了还留着它的闭包,studio 就成了泄漏源。
   */
  const gateHandlers = new Map<string, Set<StudioDispatchGateHandler>>();
  /**
   * threadId → 这次派活是谁发起的,用于把闸门变化只送回发起方。
   * `source` 为 undefined 表示宿主派的 —— 没有插件在听。
   */
  const dispatchOrigins = new Map<string, {
    source?: string;
    petId: string;
    correlationId?: string;
  }>();

  function emitGateChange(threadId: string, state: PetGateState): void {
    const origin = dispatchOrigins.get(threadId);
    // 宿主派的活没有插件在听 —— 宿主要听就写个插件(计划中的 http plugin)。
    if (!origin?.source) return;
    const listeners = gateHandlers.get(origin.source);
    if (!listeners?.size) return;

    const change: StudioDispatchGateChange = {
      threadId,
      petId: origin.petId,
      ...(origin.correlationId ? { correlationId: origin.correlationId } : {}),
      state,
    };
    for (const handler of listeners) {
      void (async () => {
        try {
          await handler(change);
        } catch (error) {
          console.error(
            `[studio] dispatch gate handler failed (plugin=${origin.source}, thread=${threadId}):`,
            error instanceof Error ? error.message : error,
          );
        }
      })();
    }
  }

  function listPets(): PetAgentRuntimeDescriptor[] {
    return [...petsById.values()].map((pet) => pet.descriptor());
  }

  function subscribe(handler: StudioEventHandler): () => void {
    handlers.add(handler);
    return () => handlers.delete(handler);
  }

  function notify(event: StudioEvent): void {
    for (const handler of handlers) {
      // 一个订阅方抛错不应牵连其他订阅方,也不应回溯影响发布方 ——
      // event 是单向通知,发出即结束。
      void (async () => {
        try {
          await handler(event);
        } catch (error) {
          console.error(
            `[studio] event handler failed (type=${event.type}, source=${event.source}):`,
            error instanceof Error ? error.message : error,
          );
        }
      })();
    }
  }

  /**
   * 每个 pet 一条队列。studio 收下所有 dispatch,pet 空了就发 ——
   * **插件完全不用关心 pet 忙不忙。**
   *
   * 这是"所有派活必经 studio"要解决的实际问题:多个插件(kanban、scheduler、
   * http…)会并发给同一个 pet 派活。若不排队,第二个撞上 `status === 'active'`
   * 就被拒,派活凭空丢掉 —— 而"失败留着等人"(§4.2)说的是任务失败,不是
   * "插板忙,请稍后"。这两件事不该被混成同一个错误。
   *
   * 排队不是业务:它不决定派给谁(那是插件的事),只保证已经收下的派活不会
   * 因为撞车而丢。与 `notify` 保证每个订阅者都收到是同一类事。
   */
  const queues = new Map<string, Promise<void>>();

  /**
   * 挂起,直到这个 pet 的闸门重新打开,并把过程中的每一次变化报给发起方。
   *
   * 门从 `waiting` / `blocked` 回到 `open`,只可能由**人**推动 —— 用户走
   * chat 路径直接跟 pet 对话把它解开(两条路共用 checkpointer)。studio
   * 这边没有控制面,只是等着被唤醒,卡多久都合理(§4.2)。
   *
   * 注意闸门是 **pet 级**的,而队列是 **dispatch 级**的:同一时刻这个 pet
   * 上只有队列头那一条在跑,所以"门开了"就等价于"队列头这条走完了"。
   * 这个等价关系依赖串行 —— 它正是队列存在的另一半理由。
   */
  /** shutdown 时用来叫醒所有卡在闸门上的等待,让队列干净地收尾。 */
  const gateWaiters = new Set<() => void>();
  function abortGateWaits(): void {
    for (const abort of [...gateWaiters]) abort();
    gateWaiters.clear();
  }

  function waitForGateOpen(pet: PetAgentRuntime, threadId: string): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (unsubscribe: () => void, opened: boolean) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        gateWaiters.delete(abort);
        resolve(opened);
      };
      const unsubscribe = pet.onGateChange((state) => {
        // 卡住期间的每一次转折(waiting → blocked 之类)都要报给发起方,
        // 否则它只看到最初那一下,之后的变化全丢。
        if (!settled && state !== 'open') emitGateChange(threadId, state);
        if (state === 'open') finish(unsubscribe, true);
      });
      const abort = () => finish(unsubscribe, false);
      gateWaiters.add(abort);
      // 订阅与检查之间可能已经开了,补一次。
      if (pet.gate() === 'open') finish(unsubscribe, true);
      else if (stopped) abort();
    });
  }

  function enqueue(petId: string, run: () => Promise<void>): void {
    const tail = queues.get(petId) ?? Promise.resolve();
    const next = tail.then(run, run);
    queues.set(petId, next);
    // 队列跑空后清掉,避免 map 无限增长。
    void next.finally(() => {
      if (queues.get(petId) === next) queues.delete(petId);
    });
  }

  async function dispatch(
    request: StudioDispatchInput,
    source?: string,
  ): Promise<StudioDispatchResult> {
    if (stopped) {
      throw new Error(`studio "${input.studioId}": already shut down`);
    }
    const pet = petsById.get(request.petId);
    if (!pet) {
      throw new Error(`studio "${input.studioId}": unknown petId "${request.petId}"`);
    }
    // 只拦永久不可派发的(disabled)。"正忙"不是错误 —— 那正是队列存在的理由。
    if (pet.descriptor().startupMode === 'disabled') {
      throw new Error(
        `studio "${input.studioId}": pet "${request.petId}" is disabled`,
      );
    }

    const threadId = `studio:${input.studioId}:pet:${request.petId}:dispatch:${randomUUID()}`;

    // 谁派的。插件派活时由 studio 从它的 context 补齐(插件填不了也不用填 ——
    // 自报的来源迟早会撒谎),缺省表示不来自任何插件。
    //
    // **目前只做记录。** dispatch 是点对点的 —— 它不上 event 总线(那会让
    // 每个插件都看见谁给谁派了活),也不进 pet.invoke(pet 不需要知道谁派的)。
    console.log(
      `[studio] dispatch petId=${request.petId} source=${source ?? 'studio'} thread=${threadId}`,
    );

    dispatchOrigins.set(threadId, {
      ...(source ? { source } : {}),
      petId: request.petId,
      ...(request.correlationId ? { correlationId: request.correlationId } : {}),
    });

    // 排到该 pet 的队尾。dispatch 本身立即返回 —— studio 不等 pet 干完,
    // 也不解释它的返回值。pet 的产出经由 toolkit → 插件 → event 汇报。
    enqueue(request.petId, async () => {
      emitGateChange(threadId, 'busy');
      try {
        await pet.invoke({
          brief: request.request,
          threadId,
          ...(request.signal ? { signal: request.signal } : {}),
        });
      } catch (error) {
        // 派活失败只记录:判定与善后属于插件的领域,studio 不越权处理。
        console.error(
          `[studio] dispatch failed (petId=${request.petId}, threadId=${threadId}):`,
          error instanceof Error ? error.message : error,
        );
      }

      // invoke 返回不等于活干完了 —— pet 撞到人工确认时会提前返回。真相在
      // 闸门上:`waiting` / `blocked` 都还占着这个 pet,队列不放行下一条。
      const state = pet.gate();
      emitGateChange(threadId, state);
      if (state !== 'open') {
        const opened = await waitForGateOpen(pet, threadId);
        // 人把门解开了 —— 发起方要知道自己这条终于走完了,否则它只看到
        // 「卡住」而永远等不到收尾。shutdown 打断时不报:那条活并没有走完。
        if (opened) emitGateChange(threadId, 'open');
      }
      dispatchOrigins.delete(threadId);
    });

    return { threadId };
  }

  function buildPluginContext(plugin: StudioPlugin): StudioPluginContext {
    return {
      // source 由 studio 从 context 补,与 notify 同理。
      dispatch: (request: StudioDispatchInput) => dispatch(request, plugin.name),
      onDispatchGate: (handler: StudioDispatchGateHandler) => {
        const listeners = gateHandlers.get(plugin.name) ?? new Set();
        listeners.add(handler);
        gateHandlers.set(plugin.name, listeners);
        return () => listeners.delete(handler);
      },
      notify: (event: StudioEventInput) => notify({
        ...event,
        source: plugin.name,
        occurredAt: new Date().toISOString(),
      }),
      subscribe,
      listPets,
    };
  }

  async function shutdown(): Promise<void> {
    // 关上门:此后不再收 dispatch。否则派出去的活没有任何插件在听它的产出。
    stopped = true;
    // 唤醒所有卡在闸门上的队列。**不能等它们跑完** —— `waiting` / `blocked`
    // 按设计可能永远等不到人(§4.2),等下去 shutdown 就永远返回不了。
    // 队列因此在这里放弃等待:已排队未开始的活不会再派出去。
    abortGateWaits();
    // 逆序停止:后启动的插件可能依赖先启动的。
    for (const plugin of [...plugins].reverse()) {
      try {
        await plugin.studio?.stop?.();
        // 插件停了就清掉它的订阅 —— 留着闭包 studio 就成了泄漏源。
        gateHandlers.delete(plugin.name);
      } catch (error) {
        console.error(
          `[studio] plugin "${plugin.name}" failed to stop:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    handlers.clear();
    gateHandlers.clear();
    dispatchOrigins.clear();
  }

  // 插件启动失败必须让调用方看见 —— 一个没起来的驱动器意味着这块 studio
  // 不会派活,静默吞掉会变成"提交了但什么都没发生"。
  for (const plugin of plugins) {
    await plugin.studio?.start(buildPluginContext(plugin));
  }

  return {
    entryPetId: input.entryPetId,
    dispatch,
    notify,
    subscribe,
    listPets,
    shutdown,
  };
}
