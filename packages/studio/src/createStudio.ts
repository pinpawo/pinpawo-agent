import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { allocatePetSessionId } from 'pinpawo/host-runtime';

import {
  StudioPetUnavailableError,
  type Studio,
  type StudioEvent,
  type StudioEventInput,
  type StudioPetSessions,
  type StudioPlugin,
  type StudioPluginContext,
  type StudioModels,
} from './studioContract';
import type {
  StudioDispatchReceipt,
  StudioDispatchRequest,
} from './studioInvocation';
import type { StudioPetAssembler, StudioPetDefinition, StudioPetRegistration } from './types';
import { StudioEventBus } from './studioEventBus';
import { StudioPluginHookRegistry } from './studioPluginHooks';
import { createStudioStorage, type StudioStorageConfig } from './storage/studioStorage';
import { StudioClients } from './clients/studioClients';
import { KyselyClientStore, type ClientDatabase } from './clients/store/kysely';
import { KyselyPetStore, type PetDatabase } from './pets/store/kysely';
import { StudioPetRegistry, type LiveStudioPet } from './pets/studioPets';
import { studioCoreMigrations } from './storage/coreMigrations';

export type CreateStudioInput = {
  studioId: string;
  /** The definitions this Studio may create Pets from. */
  definitions: StudioPetDefinition[];
  /** Builds one Pet's runtime; Studio calls it for each active Pet and for each Pet it creates. */
  assemblePet: StudioPetAssembler;
  plugins?: StudioPlugin[];
  /** Where Plugins keep their data. Defaults to an in-memory SQLite database. */
  storage?: StudioStorageConfig;
  /** Model profiles Plugins may call directly. Without them, `models.resolve` throws. */
  models?: StudioModels;
};

export type PreparedStudio = {
  studio: Studio;
  /** Assemble the Studio's active Pets. Idempotent; activatePlugins runs it first. */
  restorePets: () => Promise<void>;
  /** Start Plugin lifecycles after the composing Host has opened interaction transports. */
  activatePlugins: () => Promise<void>;
};

/** Prepare the Studio registry without running executable Plugin lifecycles. */
export function prepareStudio(input: CreateStudioInput): PreparedStudio {
  const plugins = input.plugins ?? [];
  const pluginNames = new Set<string>();
  for (const plugin of plugins) {
    if (!plugin.name.trim()) throw new Error(`studio "${input.studioId}": plugin name must not be empty`);
    // `studio` is the core's own event source and storage owner.
    if (plugin.name === 'studio') throw new Error(`studio "${input.studioId}": plugin name "studio" is reserved`);
    if (pluginNames.has(plugin.name)) {
      throw new Error(`studio "${input.studioId}": duplicate plugin "${plugin.name}"`);
    }
    pluginNames.add(plugin.name);
  }

  const eventBus = new StudioEventBus();
  const idempotencyRecords = new Map<string, Promise<StudioDispatchReceipt>>();
  const pluginHooks = new StudioPluginHookRegistry();
  const storage = createStudioStorage(input.storage ?? { kind: 'sqlite', path: ':memory:' });
  let coreDb: Promise<Kysely<unknown>> | undefined;
  const openCore = async <DB>() => {
    coreDb ??= storage.open<unknown>('studio', studioCoreMigrations);
    coreDb.catch(() => { coreDb = undefined; });
    return (await coreDb) as Kysely<DB>;
  };
  const clients = new StudioClients(async () => new KyselyClientStore(await openCore<ClientDatabase>()));
  const models: StudioModels = input.models ?? {
    resolve: () => { throw new Error(`studio "${input.studioId}" has no model profiles.`); },
  };
  const startedPlugins: StudioPlugin[] = [];
  let activationPromise: Promise<void> | null = null;
  let shutdownPromise: Promise<void> | null = null;
  let eventBusClosed = false;
  let stopped = false;

  const lifecycleObservers = new Map<string, () => void>();
  const registry = new StudioPetRegistry({
    studioId: input.studioId,
    store: async () => new KyselyPetStore(await openCore<PetDatabase>()),
    definitions: input.definitions,
    assemble: input.assemblePet,
    onLive: (pet) => lifecycleObservers.set(pet.registration.petId, observeDispatchLifecycle(pet)),
    onRetired: (petId) => {
      lifecycleObservers.get(petId)?.();
      lifecycleObservers.delete(petId);
    },
    onChange: (type, pet) => notify({ type, source: 'studio', occurredAt: new Date().toISOString(), payload: { pet } }),
  });

  function listPets(): StudioPetRegistration[] {
    return registry.listLive().map(({ registration }) => ({ ...registration }));
  }

  function listDispatchQueues() {
    return registry.listLive().map(({ registration, runtime }) => ({
      petId: registration.petId,
      ...runtime.dispatch.getQueueSnapshot(),
    }));
  }

  const petSessionPort = (petId: string) => {
    const port = registry.getLive(petId)?.runtime.sessions;
    if (!port) throw new StudioPetUnavailableError(petId);
    return port;
  };
  const petSessions: StudioPetSessions = {
    snapshot: async (petId, sessionId, options) => petSessionPort(petId).snapshot(sessionId, options),
    observe: async (petId, sessionId, listener, options) => petSessionPort(petId).observe(sessionId, listener, options),
    review: async (petId, sessionId, request) => petSessionPort(petId).review(sessionId, request),
  };

  function notify(event: Omit<StudioEvent, 'eventId'> & { eventId?: string }): void {
    eventBus.publish({ ...event, eventId: event.eventId ?? randomUUID() });
  }

  function observeDispatchLifecycle(pet: LiveStudioPet): () => void {
    return pet.runtime.dispatch.onDispatchLifecycle((event) => {
      notify({
        type: `dispatch.${event.state}`,
        source: 'resident-pet',
        occurredAt: new Date().toISOString(),
        payload: {
          invocationId: event.dispatchId,
          petId: pet.registration.petId,
          request: event.request,
          ...(event.requestId ? { requestId: event.requestId } : {}),
          ...(event.sessionId ? { sessionId: event.sessionId } : {}),
          ...(event.scope ? { scope: { ...event.scope } } : {}),
          ...(event.pendingInterrupt ? { pendingInterrupt: event.pendingInterrupt } : {}),
          ...(event.reply !== undefined ? { reply: event.reply } : {}),
          ...(event.message ? { message: structuredClone(event.message) } : {}),
          ...(event.error ? { error: event.error } : {}),
        },
      });
    });
  }

  async function dispatch(
    request: StudioDispatchRequest,
    source?: string,
  ): Promise<StudioDispatchReceipt> {
    if (stopped) throw new Error(`studio "${input.studioId}": already shut down`);
    await registry.restore();
    const pet = registry.getLive(request.petId);
    if (!pet) throw await registry.explainUnavailable(request.petId);

    const idempotencyKey = request.idempotencyKey?.trim();
    if (request.idempotencyKey !== undefined && !idempotencyKey) {
      throw new Error('Studio dispatch idempotencyKey must not be empty.');
    }
    const idempotencyRecordKey = idempotencyKey
      ? JSON.stringify([source ?? 'studio', request.petId, idempotencyKey])
      : null;
    const existing = idempotencyRecordKey
      ? idempotencyRecords.get(idempotencyRecordKey)
      : undefined;
    if (existing) return existing;

    // Reserve before awaiting the port: simultaneous deliveries share one
    // admission. Failed admissions release the reservation, in this domain.
    const admission = Promise.resolve().then(async () => {
      const invocationId = randomUUID();
      const metadata = request.metadata ? Object.freeze({ ...request.metadata }) : undefined;

      console.log(
        `[studio] dispatch petId=${request.petId} source=${source ?? 'studio'} invocation=${invocationId}`,
      );
      await pet.runtime.dispatch.dispatch({
        request: request.request,
        dispatchId: invocationId,
        ...(request.session ? { session: { ...request.session } } : {}),
        ...(request.scope ? { scope: { ...request.scope } } : {}),
      });

      const receipt: StudioDispatchReceipt = Object.freeze({
        petId: request.petId,
        invocationId,
        ...(metadata ? { metadata } : {}),
      });
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
    });
    if (idempotencyRecordKey) idempotencyRecords.set(idempotencyRecordKey, admission);
    try { return await admission; }
    catch (error) {
      if (idempotencyRecordKey && idempotencyRecords.get(idempotencyRecordKey) === admission) idempotencyRecords.delete(idempotencyRecordKey);
      throw error;
    }
  }

  function buildPluginContext(plugin: StudioPlugin): StudioPluginContext {
    return {
      dispatch: (request) => dispatch(request, plugin.name),
      allocateSessionId: allocatePetSessionId,
      notify: (event: StudioEventInput) => notify({
        ...event,
        source: plugin.name,
        occurredAt: new Date().toISOString(),
      }),
      subscribe: (handler) => eventBus.subscribe(handler, plugin.name),
      listPets,
      pets: registry,
      listDispatchQueues,
      petSessions,
      hooks: pluginHooks.contextFor(plugin.name),
      clients,
      models,
      storage: {
        dialect: storage.dialect,
        open: (migrations) => storage.open(plugin.name, migrations),
      },
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
    // After every Plugin stopped: nothing dispatches any more.
    await registry.close();
    await eventBus.close();
    idempotencyRecords.clear();
    // After every Plugin stopped: none of them may still be writing.
    await storage.close().catch((error: unknown) => {
      console.error('[studio] storage failed to close:', error instanceof Error ? error.message : error);
    });
  }

  async function activatePlugins(): Promise<void> {
    if (activationPromise) return activationPromise;
    if (stopped) throw new Error(`studio "${input.studioId}": already shut down`);
    const pending = (async () => {
      try {
        await registry.restore();
        for (const plugin of plugins) {
          if (stopped) throw new Error(`studio "${input.studioId}": shutdown during Plugin startup`);
          // Include the currently starting Plugin in rollback: start() may have
          // acquired resources before rejecting.
          startedPlugins.push(plugin);
          await plugin.start(buildPluginContext(plugin));
        }
        // Every hook a Plugin can contribute to is exposed by now, so work that
        // depends on another Plugin can start without guessing at start order.
        notify({ type: 'plugins.activated', source: 'studio', occurredAt: new Date().toISOString() });
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
    dispatch,
    notify,
    subscribe: (handler) => eventBus.subscribe(handler),
    listPets,
    pets: registry,
    shutdown,
  };
  return { studio, restorePets: () => registry.restore(), activatePlugins };
}

/** Create a Studio, assemble its active Pets and activate its Plugins. */
export async function createStudio(input: CreateStudioInput): Promise<Studio> {
  const prepared = prepareStudio(input);
  await prepared.activatePlugins();
  return prepared.studio;
}
