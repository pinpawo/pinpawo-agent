import { randomUUID } from 'node:crypto';

import type {
  Studio,
  StudioEvent,
  StudioEventInput,
  StudioPlugin,
  StudioPluginContext,
} from './studioContract';
import type {
  StudioDispatchReceipt,
  StudioDispatchRequest,
} from './studioInvocation';
import type { StudioPetBinding, StudioPetRegistration } from './types';
import { StudioEventBus } from './studioEventBus';
import { StudioPluginHookRegistry } from './studioPluginHooks';

export type CreateStudioInput = {
  studioId: string;
  pets: StudioPetBinding[];
  entryPetId: string;
  plugins?: StudioPlugin[];
};

/** Create the Studio registry over already-live, Host-owned dispatch ports. */
export async function createStudio(input: CreateStudioInput): Promise<Studio> {
  const petsById = new Map<string, StudioPetBinding>();
  for (const pet of input.pets) {
    const { petId } = pet.registration;
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
    if (!plugin.name.trim()) throw new Error(`studio "${input.studioId}": plugin name must not be empty`);
    if (pluginNames.has(plugin.name)) {
      throw new Error(`studio "${input.studioId}": duplicate plugin "${plugin.name}"`);
    }
    pluginNames.add(plugin.name);
  }

  const eventBus = new StudioEventBus();
  const idempotencyRecords = new Map<string, StudioDispatchReceipt>();
  const pluginHooks = new StudioPluginHookRegistry();
  let stopped = false;

  function listPets(): StudioPetRegistration[] {
    return [...petsById.values()].map(({ registration }) => ({ ...registration }));
  }

  function notify(event: StudioEvent): void {
    eventBus.publish(event);
  }

  async function dispatch(
    request: StudioDispatchRequest,
    source?: string,
  ): Promise<StudioDispatchReceipt> {
    if (stopped) throw new Error(`studio "${input.studioId}": already shut down`);
    const pet = petsById.get(request.petId);
    if (!pet) throw new Error(`studio "${input.studioId}": unknown petId "${request.petId}"`);

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

    const invocationId = randomUUID();
    const metadata = request.metadata ? Object.freeze({ ...request.metadata }) : undefined;

    console.log(
      `[studio] dispatch petId=${request.petId} source=${source ?? 'studio'} invocation=${invocationId}`,
    );
    await pet.dispatch.dispatch({ request: request.request });

    const receipt: StudioDispatchReceipt = Object.freeze({
      petId: request.petId,
      invocationId,
      ...(metadata ? { metadata } : {}),
    });
    if (idempotencyRecordKey) idempotencyRecords.set(idempotencyRecordKey, receipt);
    return receipt;
  }

  function buildPluginContext(plugin: StudioPlugin): StudioPluginContext {
    return {
      dispatch: (request) => dispatch(request, plugin.name),
      notify: (event: StudioEventInput) => notify({
        ...event,
        source: plugin.name,
        occurredAt: new Date().toISOString(),
      }),
      subscribe: (handler) => eventBus.subscribe(handler, plugin.name),
      listPets,
      hooks: pluginHooks.contextFor(plugin.name),
    };
  }

  async function shutdown(): Promise<void> {
    stopped = true;
    for (const plugin of [...plugins].reverse()) {
      eventBus.releaseOwner(plugin.name);
      try {
        await plugin.stop?.();
      } catch (error) {
        console.error(
          `[studio] plugin "${plugin.name}" failed to stop:`,
          error instanceof Error ? error.message : error,
        );
      } finally {
        eventBus.releaseOwner(plugin.name);
        pluginHooks.releasePlugin(plugin.name);
      }
    }
    await eventBus.close();
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
      eventBus.releaseOwner(plugin.name);
      try {
        await plugin.stop?.();
      } catch (rollbackError) {
        console.error(
          `[studio] plugin "${plugin.name}" failed to roll back after startup failure:`,
          rollbackError instanceof Error ? rollbackError.message : rollbackError,
        );
      } finally {
        eventBus.releaseOwner(plugin.name);
        pluginHooks.releasePlugin(plugin.name);
      }
    }
    await eventBus.close();
    idempotencyRecords.clear();
    throw error;
  }

  return {
    entryPetId: input.entryPetId,
    dispatch,
    notify,
    subscribe: (handler) => eventBus.subscribe(handler),
    listPets,
    shutdown,
  };
}
