import { createHmac, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import type { StudioEvent, StudioPlugin, StudioPluginContext } from '@pinpawo/studio';
import type { StudioHttpRoutesHook } from '@pinpawo-plugin/studio-http';
import { TriggerService } from './triggerService';

export type HttpTriggerSource = {
  kind: 'http';
  secret: string;
};

export type StudioEventTriggerSource = {
  kind: 'studio_event';
  eventSource: string;
  type?: string;
  typePrefix?: string;
};

export type GitHubTriggerSource = {
  kind: 'github';
  secret: string;
  event: string;
  action?: string;
};

export type TriggerRequestTemplate = {
  /** Logic-free interpolation over the normalized Trigger request envelope. */
  template: string;
  /** Optional envelope paths appended as a bounded, explicit JSON context. */
  context?: readonly string[];
};

export type TriggerRequest = string | TriggerRequestTemplate;

/** Explicit rule-owned target resolution. The producer only supplies event facts. */
export type TriggerTarget =
  | { kind: 'pet'; petId: string }
  | { kind: 'event_payload'; path: string; allowedPetIds?: readonly string[] };

export type TriggerDefinition = {
  triggerId: string;
  source: HttpTriggerSource | StudioEventTriggerSource | GitHubTriggerSource;
  /** Legacy shorthand for a static target. New rules should use target. */
  petId?: string;
  target?: TriggerTarget;
  request: TriggerRequest;
};

export type CreateTriggerPluginOptions = {
  triggers: readonly TriggerDefinition[];
  service?: TriggerService;
  databasePath?: string;
  httpRoute?: false | { pluginName?: string };
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

function verifyGitHubSignature(body: string, signature: string | string[] | undefined, secret: string): boolean {
  if (typeof signature !== 'string' || !signature.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  return secureEqual(signature, expected);
}

function readTriggerSecret(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  return /^Trigger\s+(.+)$/i.exec(header)?.[1]?.trim() || null;
}

function readHeaderValue(header: string | string[] | undefined): string | null {
  return typeof header === 'string' && header.trim() ? header.trim() : null;
}

function readCursor(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`Trigger ${name} must be a non-negative integer.`);
  return Number(raw);
}

function stringifyTriggerContext(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return '{"unserializable":true}';
  }
}

type TriggerRequestEnvelope = {
  triggerId: string;
  source: {
    kind: 'http' | 'github' | 'studio_event';
    event?: string;
    action?: string;
    deliveryId?: string;
  };
  event?: {
    source: string;
    type: string;
    metadata?: StudioEvent['metadata'];
    occurredAt: string;
  };
  payload: unknown;
};

const TEMPLATE_EXPRESSION = /{{\s*([A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*)\s*}}/g;
const BLOCKED_PATH_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

function validateTemplatePath(value: string, label: string): string {
  const candidate = value.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/.test(candidate)
    || candidate.split('.').some((segment) => BLOCKED_PATH_SEGMENTS.has(segment))) {
    throw new Error(`${label} must be a safe dot-separated Trigger context path.`);
  }
  return candidate;
}

function readEnvelopePath(envelope: TriggerRequestEnvelope, pathValue: string): unknown {
  let current: unknown = envelope;
  for (const segment of pathValue.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)
      || !Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function renderTemplateValue(value: unknown): string {
  return typeof value === 'string' ? value : stringifyTriggerContext(value);
}

function renderTriggerRequest(
  request: TriggerRequestTemplate,
  envelope: TriggerRequestEnvelope,
): string {
  const rendered = request.template.replace(TEMPLATE_EXPRESSION, (_expression, rawPath: string) => {
    const pathValue = validateTemplatePath(rawPath, 'Trigger request template expression');
    const value = readEnvelopePath(envelope, pathValue);
    if (value === undefined) {
      throw new Error(`Trigger request template path "${pathValue}" is unavailable.`);
    }
    return renderTemplateValue(value);
  });
  const selected = Object.fromEntries((request.context ?? []).flatMap((pathValue) => {
    const value = readEnvelopePath(envelope, pathValue);
    return value === undefined ? [] : [[pathValue, value]];
  }));
  return Object.keys(selected).length > 0
    ? `${rendered}\n\nTrigger context:\n${stringifyTriggerContext(selected)}`
    : rendered;
}

function buildTriggerRequestEnvelope(
  definition: TriggerDefinition,
  context:
    | { kind: 'http'; payload: unknown }
    | { kind: 'github'; event: string; action?: string; deliveryId: string; payload: unknown }
    | { kind: 'studio_event'; event: StudioEvent },
): TriggerRequestEnvelope {
  if (context.kind === 'http') {
    return {
      triggerId: definition.triggerId,
      source: { kind: 'http' },
      payload: context.payload,
    };
  }
  if (context.kind === 'github') {
    return {
      triggerId: definition.triggerId,
      source: {
        kind: 'github',
        event: context.event,
        ...(context.action === undefined ? {} : { action: context.action }),
        deliveryId: context.deliveryId,
      },
      payload: context.payload,
    };
  }
  return {
    triggerId: definition.triggerId,
    source: { kind: 'studio_event' },
    event: {
      source: context.event.source,
      type: context.event.type,
      ...(context.event.metadata === undefined ? {} : { metadata: context.event.metadata }),
      occurredAt: context.event.occurredAt,
    },
    payload: context.event.payload,
  };
}

function buildTriggerRequest(
  definition: TriggerDefinition,
  context:
    | { kind: 'http'; payload: unknown }
    | { kind: 'github'; event: string; action?: string; deliveryId: string; payload: unknown }
    | { kind: 'studio_event'; event: StudioEvent },
): string {
  if (typeof definition.request !== 'string') {
    return renderTriggerRequest(
      definition.request,
      buildTriggerRequestEnvelope(definition, context),
    );
  }
  const detail = context.kind === 'http'
    ? { source: 'http', payload: context.payload }
    : context.kind === 'github'
      ? {
        source: 'github',
        event: context.event,
        ...(context.action === undefined ? {} : { action: context.action }),
        deliveryId: context.deliveryId,
        payload: context.payload,
      }
    : {
      source: context.event.source,
      type: context.event.type,
      metadata: context.event.metadata,
      payload: context.event.payload,
      occurredAt: context.event.occurredAt,
    };
  return `${definition.request}\n\nTrigger context:\n${stringifyTriggerContext(detail)}`;
}

function triggerTarget(definition: TriggerDefinition): TriggerTarget {
  if (definition.target) return definition.target;
  if (definition.petId) return { kind: 'pet', petId: definition.petId };
  throw new Error(`Trigger "${definition.triggerId}" has no target.`);
}

function resolveTargetPetId(definition: TriggerDefinition, envelope: TriggerRequestEnvelope): string {
  const target = triggerTarget(definition);
  if (target.kind === 'pet') return target.petId;
  const value = readEnvelopePath(envelope, target.path);
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Trigger "${definition.triggerId}" target path "${target.path}" did not resolve to a petId.`);
  }
  const petId = value.trim();
  if (target.allowedPetIds && !target.allowedPetIds.includes(petId)) {
    throw new Error(`Trigger "${definition.triggerId}" target "${petId}" is not allowed by this rule.`);
  }
  return petId;
}

function permitsTargetPetId(definition: TriggerDefinition, petId: string): boolean {
  const target = triggerTarget(definition);
  return target.kind === 'pet'
    ? target.petId === petId
    : target.allowedPetIds === undefined || target.allowedPetIds.includes(petId);
}

function matchesStudioEvent(source: StudioEventTriggerSource, event: StudioEvent): boolean {
  if (source.eventSource !== event.source) return false;
  if (source.type !== undefined && source.type !== event.type) return false;
  return source.typePrefix === undefined || event.type.startsWith(source.typePrefix);
}

function publicDefinition(definition: TriggerDefinition): Record<string, unknown> {
  return {
    triggerId: definition.triggerId,
    source: definition.source.kind === 'studio_event'
      ? definition.source
      : definition.source.kind === 'github'
        ? {
          kind: 'github',
          event: definition.source.event,
          ...(definition.source.action === undefined ? {} : { action: definition.source.action }),
        }
        : { kind: 'http' },
    target: triggerTarget(definition),
    request: definition.request,
  };
}

function parseDefinitions(input: readonly TriggerDefinition[]): Map<string, TriggerDefinition> {
  const definitions = new Map<string, TriggerDefinition>();
  for (const definition of input) {
    const triggerId = definition.triggerId.trim();
    const target = definition.target
      ? definition.target.kind === 'pet'
        ? { kind: 'pet' as const, petId: definition.target.petId.trim() }
        : {
          kind: 'event_payload' as const,
          path: validateTemplatePath(definition.target.path, `Trigger "${definition.triggerId}" target path`),
          ...(definition.target.allowedPetIds === undefined ? {} : { allowedPetIds: definition.target.allowedPetIds.map((petId) => petId.trim()) }),
        }
      : definition.petId === undefined ? undefined : { kind: 'pet' as const, petId: definition.petId.trim() };
    const request = typeof definition.request === 'string'
      ? definition.request.trim()
      : {
        template: definition.request.template.trim(),
        ...(definition.request.context === undefined
          ? {}
          : { context: definition.request.context.map((pathValue) => (
            validateTemplatePath(pathValue, `Trigger "${triggerId}" request context path`)
          )) }),
      };
    if (!triggerId || !target || (target.kind === 'pet' && !target.petId) || (target.kind === 'event_payload' && target.allowedPetIds?.some((petId) => !petId)) || (typeof request === 'string' ? !request : !request.template)) {
      throw new Error('Trigger definitions require triggerId, target, and request.');
    }
    if (typeof request !== 'string') {
      const unmatched = request.template.replace(TEMPLATE_EXPRESSION, '');
      if (unmatched.includes('{{') || unmatched.includes('}}')) {
        throw new Error(`Trigger "${triggerId}" request template contains an invalid expression.`);
      }
      if (request.context
        && new Set(request.context).size !== request.context.length) {
        throw new Error(`Trigger "${triggerId}" request context paths must be unique.`);
      }
    }
    if (target.kind === 'event_payload' && target.allowedPetIds && new Set(target.allowedPetIds).size !== target.allowedPetIds.length) {
      throw new Error(`Trigger "${triggerId}" allowedPetIds must be unique.`);
    }
    if (definitions.has(triggerId)) throw new Error(`Duplicate Trigger triggerId "${triggerId}".`);
    if (definition.source.kind === 'http') {
      if (definition.source.secret.length < 16) {
        throw new Error(`HTTP Trigger "${triggerId}" requires a 16+ character secret.`);
      }
      definitions.set(triggerId, { ...definition, triggerId, target, request });
      continue;
    }
    if (definition.source.kind === 'github') {
      const event = definition.source.event.trim();
      if (!event || definition.source.secret.length < 16) {
        throw new Error(`GitHub Trigger "${triggerId}" requires an event and a 16+ character secret.`);
      }
      if (definition.source.action !== undefined && !definition.source.action.trim()) {
        throw new Error(`GitHub Trigger "${triggerId}" action must not be empty.`);
      }
      definitions.set(triggerId, {
        ...definition,
        triggerId,
        target,
        request,
        source: {
          ...definition.source,
          event,
          ...(definition.source.action === undefined ? {} : { action: definition.source.action.trim() }),
        },
      });
      continue;
    }
    const eventSource = definition.source.eventSource.trim();
    if (!eventSource || (definition.source.type !== undefined && definition.source.typePrefix !== undefined)) {
      throw new Error(
        `Studio event Trigger "${triggerId}" requires eventSource and at most one of type or typePrefix.`,
      );
    }
    if (definition.source.type !== undefined && !definition.source.type.trim()) {
      throw new Error(`Studio event Trigger "${triggerId}" type must not be empty.`);
    }
    if (definition.source.typePrefix !== undefined && !definition.source.typePrefix.trim()) {
      throw new Error(`Studio event Trigger "${triggerId}" typePrefix must not be empty.`);
    }
    definitions.set(triggerId, {
      ...definition,
      triggerId,
      target,
      request,
      source: {
        ...definition.source,
        eventSource,
        ...(definition.source.type === undefined ? {} : { type: definition.source.type.trim() }),
        ...(definition.source.typePrefix === undefined
          ? {}
          : { typePrefix: definition.source.typePrefix.trim() }),
      },
    });
  }
  return definitions;
}

export function createTriggerPlugin(options: CreateTriggerPluginOptions): TriggerPlugin {
  const definitions = parseDefinitions(options.triggers);
  const ownsService = !options.service;
  const service = options.service ?? new TriggerService(options.databasePath);
  let context: StudioPluginContext | undefined;
  let unsubscribeEvents: (() => void) | undefined;
  let unsubscribeMutations: (() => void) | undefined;
  let unregisterRoutes: (() => void) | undefined;

  return {
    name: 'trigger',
    toolkits: [],
    service,
    start: async (pluginContext) => {
      if (context) throw new Error('Trigger Plugin is already started.');
      const petIds = new Set(pluginContext.listPets().map(({ petId }) => petId));
      for (const definition of definitions.values()) {
        const target = triggerTarget(definition);
        if (target.kind === 'pet' && !petIds.has(target.petId)) {
          throw new Error(`Trigger "${definition.triggerId}" targets unknown pet "${target.petId}".`);
        }
        if (target.kind === 'event_payload') {
          for (const petId of target.allowedPetIds ?? []) {
            if (!petIds.has(petId)) throw new Error(`Trigger "${definition.triggerId}" allows unknown pet "${petId}".`);
          }
        }
      }
      context = pluginContext;
      try {
        const dispatchDelivery = async (
          definition: TriggerDefinition,
          idempotencyKey: string,
          input:
            | { kind: 'http'; payload: unknown }
            | { kind: 'github'; event: string; action?: string; deliveryId: string; payload: unknown }
            | { kind: 'studio_event'; event: StudioEvent },
        ) => {
          const envelope = buildTriggerRequestEnvelope(definition, input);
          const targetPetId = resolveTargetPetId(definition, envelope);
          if (!petIds.has(targetPetId)) {
            throw new Error(`Trigger "${definition.triggerId}" resolved unknown pet "${targetPetId}".`);
          }
          const request = buildTriggerRequest(definition, input);
          const claimed = await service.claim(definition.triggerId, idempotencyKey, { targetPetId, request });
          if (claimed.duplicate) return { duplicate: true, delivery: claimed.delivery };
          try {
            await pluginContext.dispatch({
              petId: targetPetId,
              request,
              idempotencyKey: `trigger:${claimed.delivery.deliveryId}`,
            });
            return { duplicate: false, delivery: await service.accept(claimed.delivery.deliveryId) };
          } catch (error) {
            const delivery = await service.fail(claimed.delivery.deliveryId, asError(error).message);
            return { duplicate: false, delivery, error: asError(error) };
          }
        };
        unsubscribeEvents = pluginContext.subscribe(async (event) => {
          if (!context) return;
          for (const definition of definitions.values()) {
            if (definition.source.kind !== 'studio_event'
              || !matchesStudioEvent(definition.source, event)) continue;
            const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
              ? event.payload as Record<string, unknown> : undefined;
            const suffix = typeof payload?.sequence === 'number' || typeof payload?.sequence === 'string'
              ? String(payload.sequence)
              : event.occurredAt;
            await dispatchDelivery(definition, `studio:${event.source}:${event.type}:${suffix}`, { kind: 'studio_event', event });
          }
        });
        unsubscribeMutations = service.subscribe(({ delivery, event }) => {
          pluginContext.notify({
            type: `trigger.${event.eventType}`,
            payload: {
              deliveryId: delivery.deliveryId,
              triggerId: delivery.triggerId,
              status: delivery.status,
              sequence: event.sequence,
              ...(event.note === undefined ? {} : { note: event.note }),
            },
          });
        });
        await service.init();
        const route = options.httpRoute;
        if (route !== false) {
          unregisterRoutes = pluginContext.hooks.contribute<StudioHttpRoutesHook>(
            route?.pluginName ?? 'http',
            'routes',
            (routes) => {
              const base = '/triggers';
              const unregister: Array<() => void> = [];
              try {
                unregister.push(routes.register({
                  method: 'GET', path: base,
                  handle: async () => ({
                    kind: 'json',
                    body: {
                      triggers: [...definitions.values()].map(publicDefinition),
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
                      if (!definition || definition.source.kind !== 'http'
                        || !secret || !secureEqual(secret, definition.source.secret)) {
                        return { kind: 'json', status: 401, body: { error: 'Unauthorized.' } };
                      }
                      try {
                        JSON.stringify(value.payload);
                        const result = await dispatchDelivery(definition, value.idempotencyKey, { kind: 'http', payload: value.payload });
                        return result.error
                          ? { kind: 'json', status: 422, body: { error: result.error.message, delivery: result.delivery } }
                          : { kind: 'json', status: result.duplicate ? 200 : 202, body: { duplicate: result.duplicate, delivery: result.delivery } };
                      } catch (error) {
                        return { kind: 'json', status: 422, body: { error: asError(error).message } };
                      }
                    } catch (error) {
                      return { kind: 'json', status: 400, body: { error: asError(error).message } };
                    }
                  },
                }));
                unregister.push(routes.register({
                  method: 'POST', path: `${base}/github`, authorization: 'route',
                  handle: async ({ headers, readText }) => {
                    const body = await readText();
                    const event = readHeaderValue(headers['x-github-event']);
                    const deliveryId = readHeaderValue(headers['x-github-delivery']);
                    if (!event || !deliveryId) {
                      return { kind: 'json', status: 400, body: { error: 'GitHub webhook requires X-GitHub-Event and X-GitHub-Delivery.' } };
                    }
                    const githubDefinitions = [...definitions.values()].filter((definition): definition is (
                      TriggerDefinition & { source: GitHubTriggerSource }
                    ) => definition.source.kind === 'github');
                    const signedDefinitions = githubDefinitions.filter((definition) => (
                      verifyGitHubSignature(body, headers['x-hub-signature-256'], definition.source.secret)
                    ));
                    if (!signedDefinitions.length) {
                      return { kind: 'json', status: 401, body: { error: 'Invalid GitHub webhook signature.' } };
                    }
                    let payload: unknown;
                    try {
                      payload = JSON.parse(body) as unknown;
                    } catch {
                      return { kind: 'json', status: 400, body: { error: 'GitHub webhook payload must be valid JSON.' } };
                    }
                    const payloadRecord = payload && typeof payload === 'object' && !Array.isArray(payload)
                      ? payload as Record<string, unknown>
                      : undefined;
                    const action = typeof payloadRecord?.action === 'string'
                      ? payloadRecord.action
                      : undefined;
                    const matching = signedDefinitions.filter((definition) => (
                      definition.source.event === event
                      && (definition.source.action === undefined || definition.source.action === action)
                    ));
                    if (!matching.length) {
                      return { kind: 'json', status: 202, body: { ignored: true } };
                    }
                    const deliveries = [];
                    let failed = false;
                    for (const definition of matching) {
                      const result = await dispatchDelivery(definition, deliveryId, {
                        kind: 'github', event, action, deliveryId, payload,
                      });
                      if (result.error) failed = true;
                      deliveries.push(result.delivery);
                    }
                    return {
                      kind: 'json',
                      status: failed ? 422 : 202,
                      body: { ignored: false, deliveries },
                    };
                  },
                }));
                unregister.push(routes.register({
                  method: 'POST', path: `${base}/control`, authorization: 'route',
                  handle: async ({ readJson }) => {
                    try {
                      const value = await readJson();
                      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Trigger control request must be an object.');
                      const input = value as Record<string, unknown>;
                      if (input.action !== 'retry' || typeof input.deliveryId !== 'string' || Object.keys(input).some((key) => key !== 'action' && key !== 'deliveryId')) {
                        throw new Error('Trigger control requires action "retry" and deliveryId.');
                      }
                      const prior = await service.getDelivery(input.deliveryId);
                      if (!prior || !prior.targetPetId || !prior.request) throw new Error(`Trigger delivery "${input.deliveryId}" has no retained dispatch input.`);
                      const definition = definitions.get(prior.triggerId);
                      if (!definition || !petIds.has(prior.targetPetId) || !permitsTargetPetId(definition, prior.targetPetId)) {
                        throw new Error(`Trigger delivery "${input.deliveryId}" is no longer routable by its current rule.`);
                      }
                      const targetPetId = prior.targetPetId;
                      const request = prior.request;
                      const delivery = await service.retry(input.deliveryId);
                      try {
                        await pluginContext.dispatch({ petId: targetPetId, request, idempotencyKey: `trigger:${delivery.deliveryId}` });
                        return { kind: 'json', status: 202, body: { delivery: await service.accept(delivery.deliveryId) } };
                      } catch (error) {
                        return { kind: 'json', status: 422, body: { error: asError(error).message, delivery: await service.fail(delivery.deliveryId, asError(error).message) } };
                      }
                    } catch (error) {
                      return { kind: 'json', status: 409, body: { error: asError(error).message } };
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
        unsubscribeEvents?.();
        unsubscribeEvents = undefined;
        unsubscribeMutations?.();
        unsubscribeMutations = undefined;
        unregisterRoutes?.();
        unregisterRoutes = undefined;
        if (ownsService) await service.close().catch(() => undefined);
        throw error;
      }
    },
    stop: async () => {
      context = undefined;
      unsubscribeEvents?.();
      unsubscribeEvents = undefined;
      unsubscribeMutations?.();
      unsubscribeMutations = undefined;
      unregisterRoutes?.();
      unregisterRoutes = undefined;
      if (ownsService) await service.close();
    },
  };
}

function parseSource(
  input: unknown,
  index: number,
): HttpTriggerSource | StudioEventTriggerSource | GitHubTriggerSource {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`Trigger Plugin triggers[${index.toString()}].source must be an object.`);
  }
  const source = input as Record<string, unknown>;
  if (source.kind === 'http') {
    const unknown = Object.keys(source).find((key) => !new Set(['kind', 'secretEnv']).has(key));
    if (unknown || typeof source.secretEnv !== 'string') {
      throw new Error(`HTTP Trigger source at triggers[${index.toString()}] requires only kind and secretEnv.`);
    }
    const secret = process.env[source.secretEnv];
    if (!secret) throw new Error(`Trigger Plugin environment variable "${source.secretEnv}" is not set.`);
    return { kind: 'http', secret };
  }
  if (source.kind === 'studio_event') {
    const unknown = Object.keys(source).find((key) => (
      !new Set(['kind', 'eventSource', 'type', 'typePrefix']).has(key)
    ));
    if (unknown || typeof source.eventSource !== 'string'
      || (source.type !== undefined && typeof source.type !== 'string')
      || (source.typePrefix !== undefined && typeof source.typePrefix !== 'string')) {
      throw new Error(
        `Studio event Trigger source at triggers[${index.toString()}] requires kind, eventSource, and optional type or typePrefix.`,
      );
    }
    return {
      kind: 'studio_event',
      eventSource: source.eventSource,
      ...(typeof source.type === 'string' ? { type: source.type } : {}),
      ...(typeof source.typePrefix === 'string' ? { typePrefix: source.typePrefix } : {}),
    };
  }
  if (source.kind === 'github') {
    const unknown = Object.keys(source).find((key) => (
      !new Set(['kind', 'secretEnv', 'event', 'action']).has(key)
    ));
    if (unknown || typeof source.secretEnv !== 'string' || typeof source.event !== 'string'
      || (source.action !== undefined && typeof source.action !== 'string')) {
      throw new Error(
        `GitHub Trigger source at triggers[${index.toString()}] requires kind, secretEnv, event, and optional action.`,
      );
    }
    const secret = process.env[source.secretEnv];
    if (!secret) throw new Error(`Trigger Plugin environment variable "${source.secretEnv}" is not set.`);
    return {
      kind: 'github',
      secret,
      event: source.event,
      ...(typeof source.action === 'string' ? { action: source.action } : {}),
    };
  }
  throw new Error(
    `Trigger Plugin triggers[${index.toString()}].source kind must be "http", "github", or "studio_event".`,
  );
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
    const definitionAllowed = new Set(['triggerId', 'petId', 'target', 'request', 'source']);
    const definitionUnknown = Object.keys(definition).find((key) => !definitionAllowed.has(key));
    if (definitionUnknown) {
      throw new Error(
        `Trigger Plugin triggers[${index.toString()}] option "${definitionUnknown}" is not supported.`,
      );
    }
    const target = parseInstalledTarget(definition.target, definition.petId, index);
    if (typeof definition.triggerId !== 'string'
      || !target
      || !isInstalledTriggerRequest(definition.request, index)) {
      throw new Error(
        `Trigger Plugin triggers[${index.toString()}] requires triggerId, target, request, and source.`,
      );
    }
    return {
      triggerId: definition.triggerId,
      target,
      request: definition.request,
      source: parseSource(definition.source, index),
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
      || Object.keys(httpRoute).some((key) => key !== 'pluginName')
      || ('pluginName' in httpRoute && typeof httpRoute.pluginName !== 'string'))) {
    throw new Error('Trigger Plugin option "httpRoute" must be false or a route object.');
  }
  return createTriggerPlugin({
    databasePath,
    triggers,
    ...(httpRoute !== undefined
      ? { httpRoute: httpRoute as false | { pluginName?: string } }
      : {}),
  });
}

function parseInstalledTarget(value: unknown, legacyPetId: unknown, index: number): TriggerTarget | null {
  if (value === undefined) return typeof legacyPetId === 'string' ? { kind: 'pet', petId: legacyPetId } : null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const target = value as Record<string, unknown>;
  if (target.kind === 'pet' && typeof target.petId === 'string' && Object.keys(target).every((key) => key === 'kind' || key === 'petId')) {
    return { kind: 'pet', petId: target.petId };
  }
  if (target.kind === 'event_payload' && typeof target.path === 'string'
    && (target.allowedPetIds === undefined || (Array.isArray(target.allowedPetIds) && target.allowedPetIds.every((petId) => typeof petId === 'string')))
    && Object.keys(target).every((key) => key === 'kind' || key === 'path' || key === 'allowedPetIds')) {
    return {
      kind: 'event_payload', path: target.path,
      ...(target.allowedPetIds === undefined ? {} : { allowedPetIds: target.allowedPetIds as string[] }),
    };
  }
  throw new Error(`Trigger Plugin triggers[${index.toString()}].target must be a pet or event_payload target.`);
}

function isInstalledTriggerRequest(value: unknown, index: number): value is TriggerRequest {
  if (typeof value === 'string') return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  const unknown = Object.keys(request).find((key) => !new Set(['template', 'context']).has(key));
  if (unknown || typeof request.template !== 'string'
    || (request.context !== undefined
      && (!Array.isArray(request.context)
        || request.context.some((pathValue) => typeof pathValue !== 'string')))) {
    throw new Error(
      `Trigger Plugin triggers[${index.toString()}].request must be a string or contain only template and string context paths.`,
    );
  }
  return true;
}
