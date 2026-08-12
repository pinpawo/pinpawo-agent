import { randomUUID } from 'node:crypto';

import type {
  Studio,
  StudioDispatchInput,
  StudioDispatchResult,
  StudioEvent,
  StudioEventHandler,
  StudioEventInput,
  StudioPlugin,
  StudioPluginContext,
} from './studioContract';
import type { PetAgentRuntime, PetAgentRuntimeDescriptor } from './types';

export type CreateStudioInput = {
  studioId: string;
  /** 本 studio 可派活的 pet。 */
  pets: PetAgentRuntime[];
  /** 外部入口 `submitRequest` 派给谁;必须在 `pets` 中。 */
  entryPetId: string;
  /** 装哪些插件。顺序即 start 顺序。 */
  plugins?: StudioPlugin[];
};

function isDispatchable(descriptor: PetAgentRuntimeDescriptor): boolean {
  return (
    descriptor.startupMode !== 'disabled'
    && (descriptor.status === 'standby' || descriptor.status === 'degraded')
  );
}

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

  async function dispatch(request: StudioDispatchInput): Promise<StudioDispatchResult> {
    const pet = petsById.get(request.petId);
    if (!pet) {
      throw new Error(`studio "${input.studioId}": unknown petId "${request.petId}"`);
    }
    if (!isDispatchable(pet.descriptor())) {
      throw new Error(
        `studio "${input.studioId}": pet "${request.petId}" is not dispatchable: ${pet.descriptor().status}`,
      );
    }

    const threadId = `studio:${input.studioId}:pet:${request.petId}:dispatch:${randomUUID()}`;

    // 发出即返回 —— studio 不等 pet 干完,也不解释它的返回值。pet 的产出
    // 经由 toolkit → 插件 → event 汇报,不走这条路。
    void pet.invoke({
      brief: request.request,
      threadId,
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.extraCapabilities ? { extraCapabilities: request.extraCapabilities } : {}),
      ...(request.toolkits ? { toolkits: request.toolkits } : {}),
    }).catch((error) => {
      // 派活失败只记录:判定与善后属于插件的领域,studio 不越权处理。
      console.error(
        `[studio] dispatch failed (petId=${request.petId}, threadId=${threadId}):`,
        error instanceof Error ? error.message : error,
      );
    });

    return { threadId };
  }

  function buildPluginContext(plugin: StudioPlugin): StudioPluginContext {
    return {
      dispatch,
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
    // 逆序停止:后启动的插件可能依赖先启动的。
    for (const plugin of [...plugins].reverse()) {
      try {
        await plugin.studio?.stop?.();
      } catch (error) {
        console.error(
          `[studio] plugin "${plugin.name}" failed to stop:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    handlers.clear();
  }

  // 插件启动失败必须让调用方看见 —— 一个没起来的驱动器意味着这块 studio
  // 不会派活,静默吞掉会变成"提交了但什么都没发生"。
  for (const plugin of plugins) {
    await plugin.studio?.start(buildPluginContext(plugin));
  }

  return {
    submitRequest: (goal: string) => dispatch({ petId: input.entryPetId, request: goal }),
    dispatch,
    notify,
    subscribe,
    listPets,
    shutdown,
  };
}
