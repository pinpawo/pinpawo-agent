import path from 'node:path';
import type { StudioEvent, StudioPlugin, StudioPluginContext } from '@pinpawo/studio';
import type { StudioHttpRoutesHook } from '@pinpawo-plugin/studio-http';
import { NoticeService, type NoticeLevel } from './noticeService';

export type NoticeEventSource = {
  kind: 'studio_event';
  eventSource: string;
  type?: string;
  typePrefix?: string;
};

export type NoticeRule = {
  noticeId: string;
  source: NoticeEventSource;
  title: string;
  level?: NoticeLevel;
};

export type CreateNoticePluginOptions = {
  rules: readonly NoticeRule[];
  service?: NoticeService;
  databasePath?: string;
  httpRoute?: false | { pluginName?: string };
};

export type NoticePlugin = StudioPlugin & { service: NoticeService };

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Notice ${label} must not be empty.`);
  return normalized;
}

function matches(rule: NoticeRule, event: StudioEvent): boolean {
  if (event.source !== rule.source.eventSource) return false;
  if (rule.source.type !== undefined) return event.type === rule.source.type;
  return rule.source.typePrefix === undefined || event.type.startsWith(rule.source.typePrefix);
}

function validateRule(value: unknown): NoticeRule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Notice rule must be an object.');
  }
  const rule = value as Record<string, unknown>;
  if (Object.keys(rule).some((key) => !['noticeId', 'source', 'title', 'level'].includes(key))
    || typeof rule.noticeId !== 'string'
    || typeof rule.title !== 'string'
    || !rule.source || typeof rule.source !== 'object' || Array.isArray(rule.source)) {
    throw new Error('Notice rule is invalid.');
  }
  const source = rule.source as Record<string, unknown>;
  if (Object.keys(source).some((key) => !['kind', 'eventSource', 'type', 'typePrefix'].includes(key))
    || source.kind !== 'studio_event' || typeof source.eventSource !== 'string'
    || (source.type !== undefined && typeof source.type !== 'string')
    || (source.typePrefix !== undefined && typeof source.typePrefix !== 'string')) {
    throw new Error(`Notice rule "${rule.noticeId}" source is invalid.`);
  }
  const noticeId = nonEmpty(rule.noticeId, 'rule id');
  const title = nonEmpty(rule.title, 'title');
  const eventSource = nonEmpty(source.eventSource, 'event source');
  const type = source.type === undefined ? undefined : nonEmpty(source.type, 'event type');
  const typePrefix = source.typePrefix === undefined
    ? undefined
    : nonEmpty(source.typePrefix, 'event type prefix');
  if ((type === undefined) === (typePrefix === undefined)) {
    throw new Error(`Notice rule "${noticeId}" must set exactly one of source.type or source.typePrefix.`);
  }
  if (rule.level !== undefined && (typeof rule.level !== 'string' || !['info', 'warning', 'error'].includes(rule.level))) {
    throw new Error(`Notice rule "${noticeId}" has an unsupported level.`);
  }
  return {
    noticeId,
    title,
    ...(rule.level === undefined ? {} : { level: rule.level as NoticeLevel }),
    source: {
      kind: 'studio_event',
      eventSource,
      ...(type === undefined ? {} : { type }),
      ...(typePrefix === undefined ? {} : { typePrefix }),
    },
  };
}

export function createNoticePlugin(options: CreateNoticePluginOptions): NoticePlugin {
  const rules = options.rules.map(validateRule);
  if (new Set(rules.map(({ noticeId }) => noticeId)).size !== rules.length) {
    throw new Error('Notice rule ids must be unique.');
  }
  const ownsService = !options.service;
  const service = options.service ?? new NoticeService(options.databasePath);
  let context: StudioPluginContext | undefined;
  let unsubscribe: (() => void) | undefined;
  let unsubscribeNotices: (() => void) | undefined;
  let unregisterRoutes: (() => void) | undefined;

  return {
    name: 'notice',
    toolkits: [],
    service,
    start: async (pluginContext) => {
      if (context) throw new Error('Notice Plugin is already started.');
      context = pluginContext;
      try {
        await service.init();
        unsubscribeNotices = service.subscribe((notice) => {
          pluginContext.notify({
            type: 'notice.created',
            payload: {
              noticeId: notice.noticeId,
              ruleId: notice.ruleId,
              level: notice.level,
              title: notice.title,
              source: notice.source,
              eventType: notice.eventType,
            },
          });
        });
        unsubscribe = pluginContext.subscribe((event) => {
          for (const rule of rules) {
            if (!matches(rule, event)) continue;
            void service.create({
              ruleId: rule.noticeId,
              level: rule.level ?? 'warning',
              title: rule.title,
              source: event.source,
              eventType: event.type,
              ...(event.payload === undefined ? {} : { payload: event.payload }),
              occurredAt: event.occurredAt,
            }).catch((error) => {
              pluginContext.notify({
                type: 'notice.record_failed',
                payload: { ruleId: rule.noticeId, message: asError(error).message },
              });
            });
          }
        });
        const route = options.httpRoute;
        if (route !== false) {
          unregisterRoutes = pluginContext.hooks.contribute<StudioHttpRoutesHook>(
            route?.pluginName ?? 'http',
            'routes',
            (routes) => routes.register({
              method: 'GET',
              path: '/notices',
              handle: async ({ url }) => {
                try {
                  const rawLimit = url.searchParams.get('limit');
                  const limit = rawLimit === null ? 100 : Number(rawLimit);
                  return { kind: 'json', body: await service.snapshot(limit) };
                } catch (error) {
                  return { kind: 'json', status: 400, body: { error: asError(error).message } };
                }
              },
            }),
          );
        }
      } catch (error) {
        context = undefined;
        unsubscribe?.();
        unsubscribe = undefined;
        unsubscribeNotices?.();
        unsubscribeNotices = undefined;
        unregisterRoutes?.();
        unregisterRoutes = undefined;
        if (ownsService) await service.close().catch(() => undefined);
        throw error;
      }
    },
    stop: async () => {
      context = undefined;
      unsubscribe?.();
      unsubscribe = undefined;
      unsubscribeNotices?.();
      unsubscribeNotices = undefined;
      unregisterRoutes?.();
      unregisterRoutes = undefined;
      if (ownsService) await service.close();
    },
  };
}

function readInstalledOptions(value: Record<string, unknown> | undefined): {
  rules: NoticeRule[];
  databasePath?: string;
  httpRoute?: false | { pluginName?: string };
} {
  const options = value ?? {};
  const allowed = new Set(['rules', 'databasePath', 'httpRoute']);
  const unknown = Object.keys(options).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`Notice Plugin option "${unknown}" is not supported.`);
  if (!Array.isArray(options.rules)) throw new Error('Notice Plugin option "rules" must be an array.');
  if (options.databasePath !== undefined && typeof options.databasePath !== 'string') {
    throw new Error('Notice Plugin option "databasePath" must be a string.');
  }
  const httpRoute = options.httpRoute;
  if (httpRoute !== undefined && httpRoute !== false
    && (!httpRoute || typeof httpRoute !== 'object' || Array.isArray(httpRoute)
      || Object.keys(httpRoute).some((key) => key !== 'pluginName')
      || ('pluginName' in httpRoute && typeof httpRoute.pluginName !== 'string'))) {
    throw new Error('Notice Plugin option "httpRoute" must be false or a route object.');
  }
  return {
    rules: options.rules as NoticeRule[],
    ...(typeof options.databasePath === 'string' ? { databasePath: options.databasePath } : {}),
    ...(httpRoute === undefined ? {} : { httpRoute: httpRoute as false | { pluginName?: string } }),
  };
}

export function createStudioPlugin(
  value: Record<string, unknown> | undefined,
  environment: { workdir: string },
): NoticePlugin {
  const options = readInstalledOptions(value);
  const databasePath = options.databasePath === undefined
    ? path.join(environment.workdir, '.pinpawo', 'studio', 'notice.sqlite')
    : path.isAbsolute(options.databasePath)
      ? options.databasePath
      : path.resolve(environment.workdir, options.databasePath);
  return createNoticePlugin({
    rules: options.rules,
    databasePath,
    ...(options.httpRoute === undefined ? {} : { httpRoute: options.httpRoute }),
  });
}
