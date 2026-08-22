import { randomUUID } from 'node:crypto';

import type {
  Studio,
  StudioEvent,
  StudioEventHandler,
  StudioEventInput,
  StudioPlugin,
  StudioPluginContext,
} from './studioContract';
import {
  buildStudioPetThreadId,
  type StudioDispatchReceipt,
  type StudioDispatchRequest,
  type StudioDispatchResult,
  type StudioInvocationEvent,
  type StudioInvocationEventHandler,
} from './studioInvocation';
import type { PetAgentRuntime, PetAgentRuntimeDescriptor } from './types';
import { StudioPluginHookRegistry } from './studioPluginHooks';

export type CreateStudioInput = {
  studioId: string;
  pets: PetAgentRuntime[];
  entryPetId: string;
  plugins?: StudioPlugin[];
};

/**
 * Create one resident Studio registry and invocation coordinator.
 *
 * Every Pet owns one deterministic graph thread. Dispatches are serialized by
 * Pet, but a durable interrupt settles its invocation and releases the queue;
 * a later typed dispatch resumes the same checkpoint.
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
  const pluginNames = new Set<string>();
  for (const plugin of plugins) {
    if (!plugin.name.trim()) {
      throw new Error(`studio "${input.studioId}": plugin name must not be empty`);
    }
    if (pluginNames.has(plugin.name)) {
      throw new Error(`studio "${input.studioId}": duplicate plugin "${plugin.name}"`);
    }
    pluginNames.add(plugin.name);
  }

  const eventHandlers = new Set<StudioEventHandler>();
  const invocationHandlers = new Map<string, Set<StudioInvocationEventHandler>>();
  const hostInvocationHandlers = new Set<StudioInvocationEventHandler>();
  const queues = new Map<string, Promise<void>>();
  const activeInvocations = new Map<string, AbortController>();
  const idempotencyRecords = new Map<string, StudioDispatchReceipt>();
  const pluginHooks = new StudioPluginHookRegistry();
  let stopped = false;

  function listPets(): PetAgentRuntimeDescriptor[] {
    return [...petsById.values()].map((pet) => pet.descriptor());
  }

  function subscribe(handler: StudioEventHandler): () => void {
    eventHandlers.add(handler);
    return () => eventHandlers.delete(handler);
  }

  function notify(event: StudioEvent): void {
    for (const handler of eventHandlers) {
      void invokeObserver(
        () => handler(event),
        `[studio] event handler failed (type=${event.type}, source=${event.source})`,
      );
    }
  }

  function emitInvocation(event: StudioInvocationEvent, source?: string): void {
    const listeners = [
      ...hostInvocationHandlers,
      ...(source ? invocationHandlers.get(source) ?? [] : []),
    ];
    for (const handler of listeners) {
      void invokeObserver(
        () => handler(event),
        `[studio] invocation handler failed (invocation=${event.invocationId})`,
      );
    }
  }

  function enqueue(
    petId: string,
    run: () => Promise<StudioDispatchResult>,
  ): Promise<StudioDispatchResult> {
    const tail = queues.get(petId) ?? Promise.resolve();
    const completion = tail.then(run, run);
    const settled = completion.then(
      () => undefined,
      () => undefined,
    );
    queues.set(petId, settled);
    void settled.finally(() => {
      if (queues.get(petId) === settled) queues.delete(petId);
    });
    return completion;
  }

  async function dispatch(
    request: StudioDispatchRequest,
    source?: string,
  ): Promise<StudioDispatchReceipt> {
    if (stopped) {
      throw new Error(`studio "${input.studioId}": already shut down`);
    }
    const pet = petsById.get(request.petId);
    if (!pet) {
      throw new Error(`studio "${input.studioId}": unknown petId "${request.petId}"`);
    }
    if (pet.descriptor().startupMode === 'disabled') {
      throw new Error(
        `studio "${input.studioId}": pet "${request.petId}" is disabled`,
      );
    }

    const idempotencyKey = request.idempotencyKey?.trim();
    if (request.idempotencyKey !== undefined && !idempotencyKey) {
      throw new Error('Studio dispatch idempotencyKey must not be empty.');
    }
    const idempotencyRecordKey = idempotencyKey
      ? JSON.stringify([request.petId, idempotencyKey])
      : null;
    const existing = idempotencyRecordKey
      ? idempotencyRecords.get(idempotencyRecordKey)
      : undefined;
    if (existing) return existing;

    const threadId = buildStudioPetThreadId(input.studioId, request.petId);
    const invocationId = randomUUID();
    const metadata = request.metadata
      ? Object.freeze({ ...request.metadata })
      : undefined;
    const receiptInvocationHandlers = new Set<StudioInvocationEventHandler>();
    let latestInvocationEvent: StudioInvocationEvent | undefined;

    function emitReceiptInvocation(event: StudioInvocationEvent): void {
      latestInvocationEvent = event;
      emitInvocation(event, source);
      for (const handler of receiptInvocationHandlers) {
        void invokeObserver(
          () => handler(event),
          `[studio] receipt invocation handler failed (invocation=${event.invocationId})`,
        );
      }
    }

    console.log(
      `[studio] dispatch petId=${request.petId} source=${source ?? 'studio'} `
      + `thread=${threadId} invocation=${invocationId}`,
    );

    const completion = enqueue(request.petId, async () => {
      const base = {
        petId: request.petId,
        threadId,
        invocationId,
        ...(metadata ? { metadata } : {}),
      };
      if (stopped) {
        const result: StudioDispatchResult = { ...base, status: 'cancelled' };
        emitReceiptInvocation(result);
        return result;
      }
      if (request.signal?.aborted) {
        const result: StudioDispatchResult = { ...base, status: 'cancelled' };
        emitReceiptInvocation(result);
        return result;
      }

      const controller = new AbortController();
      activeInvocations.set(invocationId, controller);
      const signal = request.signal
        ? AbortSignal.any([request.signal, controller.signal])
        : controller.signal;
      emitReceiptInvocation({ ...base, status: 'busy' });

      try {
        const result = await pet.invoke({
          input: request.input,
          threadId,
          signal,
        });
        const completed: StudioDispatchResult = result.status === 'pending_interrupt'
          ? {
              ...base,
              status: 'pending_interrupt',
              pendingInterrupt: result.pendingInterrupt,
            }
          : {
              ...base,
              status: 'completed',
              ...(result.reply ? { output: result.reply } : {}),
            };
        emitReceiptInvocation(completed);
        return completed;
      } catch (error) {
        const aborted = signal.aborted;
        const message = error instanceof Error ? error.message : String(error);
        const failed: StudioDispatchResult = {
          ...base,
          status: aborted ? 'cancelled' : 'failed',
          ...(!aborted ? { error: message } : {}),
        };
        if (!aborted) {
          console.error(
            `[studio] invocation failed (petId=${request.petId}, invocation=${invocationId}):`,
            message,
          );
        }
        emitReceiptInvocation(failed);
        return failed;
      } finally {
        activeInvocations.delete(invocationId);
      }
    });

    const receipt: StudioDispatchReceipt = Object.freeze({
      petId: request.petId,
      threadId,
      invocationId,
      ...(metadata ? { metadata } : {}),
      onInvocation: (handler) => {
        receiptInvocationHandlers.add(handler);
        const current = latestInvocationEvent;
        if (current) {
          void invokeObserver(
            () => handler(current),
            `[studio] receipt invocation handler failed (invocation=${invocationId})`,
          );
        }
        return () => receiptInvocationHandlers.delete(handler);
      },
      completion,
    });
    if (idempotencyRecordKey) {
      idempotencyRecords.set(idempotencyRecordKey, receipt);
    }
    return receipt;
  }

  function buildPluginContext(plugin: StudioPlugin): StudioPluginContext {
    return {
      dispatch: (request) => dispatch(request, plugin.name),
      onInvocation: (handler) => {
        const listeners = invocationHandlers.get(plugin.name) ?? new Set();
        listeners.add(handler);
        invocationHandlers.set(plugin.name, listeners);
        return () => listeners.delete(handler);
      },
      notify: (event: StudioEventInput) => notify({
        ...event,
        source: plugin.name,
        occurredAt: new Date().toISOString(),
      }),
      subscribe,
      listPets,
      hooks: pluginHooks.contextFor(plugin.name),
    };
  }

  async function shutdown(): Promise<void> {
    stopped = true;
    for (const controller of activeInvocations.values()) {
      controller.abort(new Error(`studio "${input.studioId}" is shutting down`));
    }
    await Promise.allSettled([...queues.values()]);
    for (const plugin of [...plugins].reverse()) {
      try {
        await plugin.stop?.();
      } catch (error) {
        console.error(
          `[studio] plugin "${plugin.name}" failed to stop:`,
          error instanceof Error ? error.message : error,
        );
      } finally {
        invocationHandlers.delete(plugin.name);
        pluginHooks.releasePlugin(plugin.name);
      }
    }
    eventHandlers.clear();
    hostInvocationHandlers.clear();
    invocationHandlers.clear();
    idempotencyRecords.clear();
  }

  const startedPlugins: StudioPlugin[] = [];
  try {
    for (const plugin of plugins) {
      startedPlugins.push(plugin);
      await plugin.start(buildPluginContext(plugin));
    }
  } catch (error) {
    stopped = true;
    for (const plugin of [...startedPlugins].reverse()) {
      try {
        await plugin.stop?.();
      } catch (rollbackError) {
        console.error(
          `[studio] plugin "${plugin.name}" failed to roll back after startup failure:`,
          rollbackError instanceof Error ? rollbackError.message : rollbackError,
        );
      } finally {
        pluginHooks.releasePlugin(plugin.name);
      }
    }
    eventHandlers.clear();
    hostInvocationHandlers.clear();
    invocationHandlers.clear();
    idempotencyRecords.clear();
    throw error;
  }

  return {
    entryPetId: input.entryPetId,
    dispatch,
    onInvocation: (handler) => {
      hostInvocationHandlers.add(handler);
      return () => hostInvocationHandlers.delete(handler);
    },
    notify,
    subscribe,
    listPets,
    shutdown,
  };
}

async function invokeObserver(run: () => void | Promise<void>, context: string) {
  try {
    await run();
  } catch (error) {
    console.error(`${context}:`, error instanceof Error ? error.message : error);
  }
}
