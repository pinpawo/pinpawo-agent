import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import type { StudioPlugin, StudioPluginContext } from '@pinpawo/studio';
import type { StudioHttpRoutesHook } from '@pinpawo-plugin/studio-http';
import { TriggerService } from './triggerService';

export type TriggerDefinition = {
  triggerId: string;
  petId: string;
  requestPrefix: string;
  secret: string;
};

export type CreateTriggerPluginOptions = {
  triggers: readonly TriggerDefinition[];
  service?: TriggerService;
  databasePath?: string;
  httpRoute?: false | { pluginName?: string; path?: string };
};

export type TriggerPlugin = StudioPlugin & { service: TriggerService };

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function readTriggerSecret(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  return /^Trigger\s+(.+)$/i.exec(header)?.[1]?.trim() || null;
}

function readCursor(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`Trigger ${name} must be a non-negative integer.`);
  return Number(raw);
}

function parseDefinitions(input: readonly TriggerDefinition[]): Map<string, TriggerDefinition> {
  const definitions = new Map<string, TriggerDefinition>();
  for (const definition of input) {
    const triggerId = definition.triggerId.trim();
    const petId = definition.petId.trim();
    const requestPrefix = definition.requestPrefix.trim();
    if (!triggerId || !petId || !requestPrefix || definition.secret.length < 16) {
      throw new Error('Trigger definitions require triggerId, petId, requestPrefix, and a 16+ character secret.');
    }
    if (definitions.has(triggerId)) throw new Error(`Duplicate Trigger triggerId "${triggerId}".`);
    definitions.set(triggerId, { ...definition, triggerId, petId, requestPrefix });
  }
  return definitions;
}

export function createTriggerPlugin(options: CreateTriggerPluginOptions): TriggerPlugin {
  const definitions = parseDefinitions(options.triggers);
  const ownsService = !options.service;
  const service = options.service ?? new TriggerService(options.databasePath);
  let context: StudioPluginContext | undefined;
  let unregisterRoutes: (() => void) | undefined;

  return {
    name: 'trigger',
    toolkits: [],
    service,
    start: async (pluginContext) => {
      if (context) throw new Error('Trigger Plugin is already started.');
      const petIds = new Set(pluginContext.listPets().map(({ petId }) => petId));
      for (const definition of definitions.values()) {
        if (!petIds.has(definition.petId)) {
          throw new Error(`Trigger "${definition.triggerId}" targets unknown pet "${definition.petId}".`);
        }
      }
      context = pluginContext;
      try {
        await service.init();
        const route = options.httpRoute;
        if (route !== false) {
          unregisterRoutes = pluginContext.hooks.contribute<StudioHttpRoutesHook>(
            route?.pluginName ?? 'http',
            'routes',
            (routes) => {
              const base = route?.path ?? '/triggers';
              const unregister: Array<() => void> = [];
              try {
                unregister.push(routes.register({
                  method: 'GET', path: base,
                  handle: async () => ({
                    kind: 'json',
                    body: {
                      triggers: [...definitions.values()].map(({ secret: _secret, ...definition }) => definition),
                      ...(await service.snapshot()),
                    },
                  }),
                }));
                unregister.push(routes.register({
                  method: 'GET', path: `${base}/events`,
                  handle: async ({ url }) => {
                    try {
                      return {
                        kind: 'json',
                        body: { events: await service.events(
                          readCursor(url, 'after', 0),
                          readCursor(url, 'limit', 200),
                        ) },
                      };
                    } catch (error) {
                      return { kind: 'json', status: 400, body: { error: asError(error).message } };
                    }
                  },
                }));
                unregister.push(routes.register({
                  method: 'POST', path: `${base}/invoke`, authorization: 'route',
                  handle: async ({ headers, readJson }) => {
                    try {
                      const value = await readJson() as Record<string, unknown>;
                      if (!value || typeof value !== 'object'
                        || typeof value.triggerId !== 'string'
                        || typeof value.idempotencyKey !== 'string'
                        || !('payload' in value)) {
                        throw new Error('Trigger request requires triggerId, idempotencyKey, and payload.');
                      }
                      const definition = definitions.get(value.triggerId);
                      const secret = readTriggerSecret(headers.authorization);
                      if (!definition || !secret || !secureEqual(secret, definition.secret)) {
                        return { kind: 'json', status: 401, body: { error: 'Unauthorized.' } };
                      }
                      const claimed = await service.claim(value.triggerId, value.idempotencyKey);
                      if (claimed.duplicate) {
                        return { kind: 'json', body: { duplicate: true, delivery: claimed.delivery } };
                      }
                      pluginContext.notify({
                        type: 'trigger.received',
                        payload: {
                          deliveryId: claimed.delivery.deliveryId,
                          triggerId: definition.triggerId,
                        },
                      });
                      try {
                        const payload = JSON.stringify(value.payload);
                        if (payload === undefined) throw new Error('Trigger payload must be JSON serializable.');
                        await pluginContext.dispatch({
                          petId: definition.petId,
                          request: `${definition.requestPrefix}\n\nTrigger payload:\n${payload}`,
                          idempotencyKey: `trigger:${claimed.delivery.deliveryId}`,
                        });
                        const delivery = await service.accept(claimed.delivery.deliveryId);
                        pluginContext.notify({
                          type: 'trigger.accepted',
                          payload: { deliveryId: delivery.deliveryId, triggerId: definition.triggerId },
                        });
                        return { kind: 'json', status: 202, body: { duplicate: false, delivery } };
                      } catch (error) {
                        const delivery = await service.fail(
                          claimed.delivery.deliveryId,
                          asError(error).message,
                        );
                        pluginContext.notify({
                          type: 'trigger.failed',
                          payload: { deliveryId: delivery.deliveryId, triggerId: definition.triggerId },
                        });
                        return { kind: 'json', status: 422, body: { error: asError(error).message, delivery } };
                      }
                    } catch (error) {
                      return { kind: 'json', status: 400, body: { error: asError(error).message } };
                    }
                  },
                }));
              } catch (error) {
                for (const remove of unregister.reverse()) remove();
                throw error;
              }
              return () => { for (const remove of unregister.reverse()) remove(); };
            },
          );
        }
      } catch (error) {
        context = undefined;
        unregisterRoutes?.();
        unregisterRoutes = undefined;
        if (ownsService) await service.close().catch(() => undefined);
        throw error;
      }
    },
    stop: async () => {
      context = undefined;
      unregisterRoutes?.();
      unregisterRoutes = undefined;
      if (ownsService) await service.close();
    },
  };
}

export function createStudioPlugin(
  value: Record<string, unknown> | undefined,
  environment: { workdir: string },
): TriggerPlugin {
  const options = value ?? {};
  const allowed = new Set(['databasePath', 'triggers', 'httpRoute']);
  const unknown = Object.keys(options).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`Trigger Plugin option "${unknown}" is not supported.`);
  if (options.databasePath !== undefined && typeof options.databasePath !== 'string') {
    throw new Error('Trigger Plugin option "databasePath" must be a string.');
  }
  if (!Array.isArray(options.triggers)) throw new Error('Trigger Plugin option "triggers" must be an array.');
  const triggers = options.triggers.map((input, index) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error(`Trigger Plugin triggers[${index.toString()}] must be an object.`);
    }
    const definition = input as Record<string, unknown>;
    const definitionAllowed = new Set(['triggerId', 'petId', 'requestPrefix', 'secretEnv']);
    const definitionUnknown = Object.keys(definition).find((key) => !definitionAllowed.has(key));
    if (definitionUnknown) {
      throw new Error(
        `Trigger Plugin triggers[${index.toString()}] option "${definitionUnknown}" is not supported.`,
      );
    }
    if (typeof definition.triggerId !== 'string'
      || typeof definition.petId !== 'string'
      || typeof definition.requestPrefix !== 'string'
      || typeof definition.secretEnv !== 'string') {
      throw new Error(
        `Trigger Plugin triggers[${index.toString()}] requires triggerId, petId, requestPrefix, and secretEnv.`,
      );
    }
    const secret = process.env[definition.secretEnv];
    if (!secret) {
      throw new Error(`Trigger Plugin environment variable "${definition.secretEnv}" is not set.`);
    }
    return {
      triggerId: definition.triggerId,
      petId: definition.petId,
      requestPrefix: definition.requestPrefix,
      secret,
    };
  });
  const databasePath = typeof options.databasePath === 'string'
    ? (path.isAbsolute(options.databasePath)
      ? options.databasePath
      : path.resolve(environment.workdir, options.databasePath))
    : path.join(environment.workdir, '.pinpawo', 'studio', 'trigger.sqlite');
  const httpRoute = options.httpRoute;
  if (httpRoute !== undefined && httpRoute !== false
    && (!httpRoute || typeof httpRoute !== 'object' || Array.isArray(httpRoute)
      || Object.keys(httpRoute).some((key) => key !== 'pluginName' && key !== 'path')
      || ('pluginName' in httpRoute && typeof httpRoute.pluginName !== 'string')
      || ('path' in httpRoute && typeof httpRoute.path !== 'string'))) {
    throw new Error('Trigger Plugin option "httpRoute" must be false or a route object.');
  }
  return createTriggerPlugin({
    databasePath,
    triggers,
    ...(httpRoute !== undefined
      ? { httpRoute: httpRoute as false | { pluginName?: string; path?: string } }
      : {}),
  });
}
