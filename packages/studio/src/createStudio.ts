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

export type PreparedStudio = {
  studio: Studio;
  /** Start Plugin lifecycles after the composing Host has opened interaction transports. */
  activatePlugins: () => Promise<void>;
};

/** Prepare the Studio registry without running executable Plugin lifecycles. */
export function prepareStudio(input: CreateStudioInput): PreparedStudio {
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
  const startedPlugins: StudioPlugin[] = [];
  let activationPromise: Promise<void> | null = null;
  let shutdownPromise: Promise<void> | null = null;
  let eventBusClosed = false;
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
    notify({
      type: 'dispatch.accepted',
      source: 'studio',
      occurredAt: new Date().toISOString(),
      payload: {
        invocationId,
        petId: request.petId,
        request: request.request,
        producer: source ?? 'studio',
      },
    });
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

  async function stopStartedPlugins(): Promise<void> {
    for (const plugin of startedPlugins.splice(0).reverse()) {
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
  }

  async function closeCore(): Promise<void> {
    if (eventBusClosed) return;
    eventBusClosed = true;
    await eventBus.close();
    idempotencyRecords.clear();
  }

  async function activatePlugins(): Promise<void> {
    if (activationPromise) return activationPromise;
    if (stopped) throw new Error(`studio "${input.studioId}": already shut down`);
    const pending = (async () => {
      try {
        for (const plugin of plugins) {
          if (stopped) throw new Error(`studio "${input.studioId}": shutdown during Plugin startup`);
          // Include the currently starting Plugin in rollback: start() may have
          // acquired resources before rejecting.
          startedPlugins.push(plugin);
          await plugin.start(buildPluginContext(plugin));
        }
      } catch (error) {
        stopped = true;
        await stopStartedPlugins();
        await closeCore();
        throw error;
      }
    })();
    activationPromise = pending;
    return pending;
  }

  async function shutdown(): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    stopped = true;
    const pending = (async () => {
      await activationPromise?.catch(() => undefined);
      await stopStartedPlugins();
      await closeCore();
    })();
    shutdownPromise = pending;
    return pending;
  }

  const studio: Studio = {
    entryPetId: input.entryPetId,
    dispatch,
    notify,
    subscribe: (handler) => eventBus.subscribe(handler),
    listPets,
    shutdown,
  };
  return { studio, activatePlugins };
}

/** Create and activate a standalone Studio over already-live dispatch ports. */
export async function createStudio(input: CreateStudioInput): Promise<Studio> {
  const prepared = prepareStudio(input);
  await prepared.activatePlugins();
  return prepared.studio;
}
