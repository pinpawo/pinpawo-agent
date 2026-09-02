import path from 'node:path';
import type { StudioDispatchQueue, StudioPlugin, StudioPluginContext } from '@pinpawo/studio';
import type { StudioHttpRoutesHook } from '@pinpawo-plugin/studio-http';
import { SchedulerService } from './schedulerService';

export type CreateSchedulerPluginOptions = {
  service?: SchedulerService;
  databasePath?: string;
  pollIntervalMs?: number;
  /** Optional recurring read-only audit of resident Pet dispatch queues. */
  dispatchQueueAudit?: false | {
    intervalMs: number;
    attentionStates?: readonly StudioDispatchQueue['state'][];
  };
  httpRoute?: false | { pluginName?: string };
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

function normalizeDispatchQueueAudit(
  audit: CreateSchedulerPluginOptions['dispatchQueueAudit'],
): { intervalMs: number; attentionStates: ReadonlySet<StudioDispatchQueue['state']> } | null {
  if (audit === undefined || audit === false) return null;
  if (!Number.isSafeInteger(audit.intervalMs) || audit.intervalMs < 1_000) {
    throw new Error('Scheduler dispatchQueueAudit.intervalMs must be an integer of at least 1000.');
  }
  const attentionStates = audit.attentionStates ?? ['waiting', 'blocked'];
  const allowedStates = new Set<StudioDispatchQueue['state']>(['open', 'busy', 'waiting', 'blocked']);
  if (attentionStates.length === 0 || attentionStates.some((state) => !allowedStates.has(state))) {
    throw new Error('Scheduler dispatchQueueAudit.attentionStates must contain known dispatch queue states.');
  }
  return {
    intervalMs: audit.intervalMs,
    attentionStates: new Set(attentionStates),
  };
}

export function createSchedulerPlugin(options: CreateSchedulerPluginOptions = {}): SchedulerPlugin {
  const ownsService = !options.service;
  const service = options.service ?? new SchedulerService(options.databasePath);
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10) {
    throw new Error('Scheduler pollIntervalMs must be an integer of at least 10.');
  }
  const dispatchQueueAudit = normalizeDispatchQueueAudit(options.dispatchQueueAudit);
  let context: StudioPluginContext | undefined;
  let timer: NodeJS.Timeout | undefined;
  let dispatchQueueAuditTimer: NodeJS.Timeout | undefined;
  let initialDispatchQueueAuditTimer: NodeJS.Timeout | undefined;
  let unsubscribeMutations: (() => void) | undefined;
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
          await service.markDispatched(schedule.scheduleId);
        } catch (error) {
          await service.fail(schedule.scheduleId, asError(error).message);
        }
      }
    })();
    try {
      await polling;
    } finally {
      polling = undefined;
    }
  };

  const requestPoll = () => {
    void poll().catch((error) => {
      context?.notify({
        type: 'schedule.poll_failed',
        payload: { message: asError(error).message },
      });
    });
  };

  const auditDispatchQueues = () => {
    if (!context || !dispatchQueueAudit) return;
    const queues = context.listDispatchQueues();
    const attention = queues.filter(({ state }) => dispatchQueueAudit.attentionStates.has(state));
    if (attention.length === 0) return;
    context.notify({
      type: 'dispatch.queues_attention_required',
      payload: {
        queues: attention,
        attentionStates: [...dispatchQueueAudit.attentionStates],
        checkedAt: new Date().toISOString(),
      },
    });
  };

  return {
    name: 'scheduler',
    toolkits: [],
    service,
    start: async (pluginContext) => {
      if (context) throw new Error('Scheduler Plugin is already started.');
      context = pluginContext;
      try {
        unsubscribeMutations = service.subscribe(({ schedule, event }) => {
          const type = event.eventType === 'dispatched'
            ? 'schedule.fired'
            : `schedule.${event.eventType}`;
          pluginContext.notify({
            type,
            payload: {
              scheduleId: schedule.scheduleId,
              petId: schedule.petId,
              status: schedule.status,
              sequence: event.sequence,
              ...(event.note === undefined ? {} : { note: event.note }),
            },
          });
          if (event.eventType === 'created') requestPoll();
        });
        await service.init();
        const route = options.httpRoute;
        if (route !== false) {
          unregisterRoutes = pluginContext.hooks.contribute<StudioHttpRoutesHook>(
            route?.pluginName ?? 'http',
            'routes',
            (routes) => {
              const base = '/scheduler';
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
        timer = setInterval(requestPoll, pollIntervalMs);
        timer.unref();
        if (dispatchQueueAudit) {
          dispatchQueueAuditTimer = setInterval(auditDispatchQueues, dispatchQueueAudit.intervalMs);
          dispatchQueueAuditTimer.unref();
          // Run after the activation loop has started all configured listeners.
          initialDispatchQueueAuditTimer = setTimeout(auditDispatchQueues, 0);
          initialDispatchQueueAuditTimer.unref();
        }
        await poll();
      } catch (error) {
        if (timer) clearInterval(timer);
        timer = undefined;
        if (dispatchQueueAuditTimer) clearInterval(dispatchQueueAuditTimer);
        dispatchQueueAuditTimer = undefined;
        if (initialDispatchQueueAuditTimer) clearTimeout(initialDispatchQueueAuditTimer);
        initialDispatchQueueAuditTimer = undefined;
        context = undefined;
        unsubscribeMutations?.();
        unsubscribeMutations = undefined;
        unregisterRoutes?.();
        unregisterRoutes = undefined;
        if (ownsService) await service.close().catch(() => undefined);
        throw error;
      }
    },
    stop: async () => {
      if (timer) clearInterval(timer);
      timer = undefined;
      if (dispatchQueueAuditTimer) clearInterval(dispatchQueueAuditTimer);
      dispatchQueueAuditTimer = undefined;
      if (initialDispatchQueueAuditTimer) clearTimeout(initialDispatchQueueAuditTimer);
      initialDispatchQueueAuditTimer = undefined;
      await polling;
      context = undefined;
      unsubscribeMutations?.();
      unsubscribeMutations = undefined;
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
  const allowed = new Set(['databasePath', 'pollIntervalMs', 'dispatchQueueAudit', 'httpRoute']);
  const unknown = Object.keys(options).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`Scheduler Plugin option "${unknown}" is not supported.`);
  if (options.databasePath !== undefined && typeof options.databasePath !== 'string') {
    throw new Error('Scheduler Plugin option "databasePath" must be a string.');
  }
  if (options.pollIntervalMs !== undefined && typeof options.pollIntervalMs !== 'number') {
    throw new Error('Scheduler Plugin option "pollIntervalMs" must be a number.');
  }
  const dispatchQueueAudit = options.dispatchQueueAudit;
  if (dispatchQueueAudit !== undefined && dispatchQueueAudit !== false
    && (!dispatchQueueAudit || typeof dispatchQueueAudit !== 'object' || Array.isArray(dispatchQueueAudit))) {
    throw new Error('Scheduler Plugin option "dispatchQueueAudit" must be false or an object.');
  }
  if (dispatchQueueAudit && typeof dispatchQueueAudit === 'object' && !Array.isArray(dispatchQueueAudit)) {
    const audit = dispatchQueueAudit as Record<string, unknown>;
    if (Object.keys(audit).some((key) => key !== 'intervalMs' && key !== 'attentionStates')
      || typeof audit.intervalMs !== 'number'
      || (audit.attentionStates !== undefined
        && (!Array.isArray(audit.attentionStates)
          || audit.attentionStates.some((state) => typeof state !== 'string')))) {
      throw new Error('Scheduler Plugin option "dispatchQueueAudit" is invalid.');
    }
  }
  const httpRoute = options.httpRoute;
  if (httpRoute !== undefined && httpRoute !== false
    && (!httpRoute || typeof httpRoute !== 'object' || Array.isArray(httpRoute)
      || Object.keys(httpRoute).some((key) => key !== 'pluginName')
      || ('pluginName' in httpRoute && typeof httpRoute.pluginName !== 'string'))) {
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
    ...(dispatchQueueAudit === false
      ? { dispatchQueueAudit: false as const }
      : dispatchQueueAudit && typeof dispatchQueueAudit === 'object' && !Array.isArray(dispatchQueueAudit)
        ? {
          dispatchQueueAudit: {
            intervalMs: (dispatchQueueAudit as { intervalMs: number }).intervalMs,
            ...((dispatchQueueAudit as { attentionStates?: string[] }).attentionStates === undefined
              ? {}
              : { attentionStates: (dispatchQueueAudit as { attentionStates: StudioDispatchQueue['state'][] }).attentionStates }),
          },
        }
        : {}),
    ...(httpRoute !== undefined
      ? { httpRoute: httpRoute as false | { pluginName?: string } }
      : {}),
  });
}
