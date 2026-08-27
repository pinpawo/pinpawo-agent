import path from 'node:path';
import type { StudioPlugin, StudioPluginContext } from '@pinpawo/studio';
import type { StudioHttpRoutesHook } from '@pinpawo-plugin/studio-http';
import { SchedulerService } from './schedulerService';

export type CreateSchedulerPluginOptions = {
  service?: SchedulerService;
  databasePath?: string;
  pollIntervalMs?: number;
  httpRoute?: false | { pluginName?: string; path?: string };
};

export type SchedulerPlugin = StudioPlugin & { service: SchedulerService };

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function readCursor(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`Scheduler ${name} must be a non-negative integer.`);
  return Number(raw);
}

export function createSchedulerPlugin(options: CreateSchedulerPluginOptions = {}): SchedulerPlugin {
  const ownsService = !options.service;
  const service = options.service ?? new SchedulerService(options.databasePath);
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10) {
    throw new Error('Scheduler pollIntervalMs must be an integer of at least 10.');
  }
  let context: StudioPluginContext | undefined;
  let timer: NodeJS.Timeout | undefined;
  let unregisterRoutes: (() => void) | undefined;
  let polling: Promise<void> | undefined;

  const poll = async () => {
    if (polling || !context) return;
    polling = (async () => {
      while (context) {
        const schedule = await service.claimDue();
        if (!schedule) break;
        try {
          await context.dispatch({
            petId: schedule.petId,
            request: schedule.request,
            idempotencyKey: `schedule:${schedule.scheduleId}`,
          });
          await service.complete(schedule.scheduleId);
          context.notify({
            type: 'schedule.fired',
            payload: { scheduleId: schedule.scheduleId, petId: schedule.petId },
          });
        } catch (error) {
          await service.fail(schedule.scheduleId, asError(error).message);
          context.notify({
            type: 'schedule.failed',
            payload: { scheduleId: schedule.scheduleId, message: asError(error).message },
          });
        }
      }
    })();
    try {
      await polling;
    } finally {
      polling = undefined;
    }
  };

  return {
    name: 'scheduler',
    toolkits: [],
    service,
    start: async (pluginContext) => {
      if (context) throw new Error('Scheduler Plugin is already started.');
      context = pluginContext;
      try {
        await service.init();
        const route = options.httpRoute;
        if (route !== false) {
          unregisterRoutes = pluginContext.hooks.contribute<StudioHttpRoutesHook>(
            route?.pluginName ?? 'http',
            'routes',
            (routes) => {
              const base = route?.path ?? '/scheduler';
              const unregister: Array<() => void> = [];
              try {
                unregister.push(routes.register({
                  method: 'GET', path: base,
                  handle: async () => ({ kind: 'json', body: await service.snapshot() }),
                }));
                unregister.push(routes.register({
                  method: 'POST', path: base,
                  handle: async ({ readJson }) => {
                    try {
                      const value = await readJson() as Record<string, unknown>;
                      if (!value || typeof value !== 'object'
                        || typeof value.petId !== 'string'
                        || typeof value.request !== 'string'
                        || typeof value.runAt !== 'string') {
                        throw new Error('Scheduler request requires petId, request, and runAt.');
                      }
                      if (!pluginContext.listPets().some(({ petId }) => petId === value.petId)) {
                        throw new Error(`Unknown Studio petId "${value.petId}".`);
                      }
                      const schedule = await service.create({
                        petId: value.petId,
                        request: value.request,
                        runAt: value.runAt,
                      });
                      pluginContext.notify({
                        type: 'schedule.created',
                        payload: { scheduleId: schedule.scheduleId, petId: schedule.petId },
                      });
                      void poll();
                      return { kind: 'json', status: 201, body: { schedule } };
                    } catch (error) {
                      return { kind: 'json', status: 400, body: { error: asError(error).message } };
                    }
                  },
                }));
                unregister.push(routes.register({
                  method: 'POST', path: `${base}/control`,
                  handle: async ({ readJson }) => {
                    try {
                      const value = await readJson() as Record<string, unknown>;
                      if (!value || value.action !== 'cancel' || typeof value.scheduleId !== 'string') {
                        throw new Error('Scheduler control requires action=cancel and scheduleId.');
                      }
                      const schedule = await service.cancel(value.scheduleId);
                      pluginContext.notify({
                        type: 'schedule.cancelled',
                        payload: { scheduleId: schedule.scheduleId, petId: schedule.petId },
                      });
                      return {
                        kind: 'json',
                        body: { schedule },
                      };
                    } catch (error) {
                      return { kind: 'json', status: 400, body: { error: asError(error).message } };
                    }
                  },
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
              } catch (error) {
                for (const remove of unregister.reverse()) remove();
                throw error;
              }
              return () => { for (const remove of unregister.reverse()) remove(); };
            },
          );
        }
        timer = setInterval(() => { void poll(); }, pollIntervalMs);
        timer.unref();
        await poll();
      } catch (error) {
        context = undefined;
        unregisterRoutes?.();
        unregisterRoutes = undefined;
        if (ownsService) await service.close().catch(() => undefined);
        throw error;
      }
    },
    stop: async () => {
      if (timer) clearInterval(timer);
      timer = undefined;
      await polling;
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
): SchedulerPlugin {
  const options = value ?? {};
  const allowed = new Set(['databasePath', 'pollIntervalMs', 'httpRoute']);
  const unknown = Object.keys(options).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`Scheduler Plugin option "${unknown}" is not supported.`);
  if (options.databasePath !== undefined && typeof options.databasePath !== 'string') {
    throw new Error('Scheduler Plugin option "databasePath" must be a string.');
  }
  if (options.pollIntervalMs !== undefined && typeof options.pollIntervalMs !== 'number') {
    throw new Error('Scheduler Plugin option "pollIntervalMs" must be a number.');
  }
  const httpRoute = options.httpRoute;
  if (httpRoute !== undefined && httpRoute !== false
    && (!httpRoute || typeof httpRoute !== 'object' || Array.isArray(httpRoute)
      || Object.keys(httpRoute).some((key) => key !== 'pluginName' && key !== 'path')
      || ('pluginName' in httpRoute && typeof httpRoute.pluginName !== 'string')
      || ('path' in httpRoute && typeof httpRoute.path !== 'string'))) {
    throw new Error('Scheduler Plugin option "httpRoute" must be false or a route object.');
  }
  const databasePath = typeof options.databasePath === 'string'
    ? (path.isAbsolute(options.databasePath)
      ? options.databasePath
      : path.resolve(environment.workdir, options.databasePath))
    : path.join(environment.workdir, '.pinpawo', 'studio', 'scheduler.sqlite');
  return createSchedulerPlugin({
    databasePath,
    ...(typeof options.pollIntervalMs === 'number' ? { pollIntervalMs: options.pollIntervalMs } : {}),
    ...(httpRoute !== undefined
      ? { httpRoute: httpRoute as false | { pluginName?: string; path?: string } }
      : {}),
  });
}
