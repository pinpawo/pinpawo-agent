import { timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
} from 'node:http';

import { getRequestListener, type HttpBindings } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';

import {
  parseStudioDispatchRequest,
  type StudioEvent,
  type StudioPlugin,
  type StudioPluginContext,
} from '@pinpawo/studio';
import { readLocalServerAuthToken } from 'pinpawo/local-server-transport';

const LOOPBACK_HOST = '127.0.0.1' as const;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_MAX_EVENT_CLIENTS = 100;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
export const STUDIO_HTTP_ROUTES_HOOK_NAME = 'routes';
const RESERVED_ROUTE_PATHS = new Set(['/dispatch', '/events', '/pets']);

type StudioHttpEnvironment = { Bindings: HttpBindings };
type StudioHttpContext = Context<StudioHttpEnvironment>;

export type StudioHttpRouteRequest = {
  readonly url: URL;
  readonly headers: Readonly<IncomingHttpHeaders>;
  readJson: () => Promise<unknown>;
};

export type StudioHttpRouteResult =
  | { kind: 'json'; body: unknown; status?: number }
  | { kind: 'text'; body: string; contentType?: string; status?: number };

export type StudioHttpRoute = {
  method: string;
  path: string;
  handle: (
    request: StudioHttpRouteRequest,
  ) => StudioHttpRouteResult | Promise<StudioHttpRouteResult>;
};

export type StudioHttpRoutesHook = {
  register: (route: StudioHttpRoute) => () => void;
};

export type StudioHttpPluginAddress = {
  readonly host: typeof LOOPBACK_HOST;
  readonly port: number;
};

export type CreateStudioHttpPluginOptions = {
  /** `0` asks the OS for an ephemeral port. */
  port: number;
  /** Bearer token used by both dispatch and SSE requests. */
  authToken: string;
  /** Exact HTTP(S) origins allowed to call the Plugin from a browser. */
  allowedOrigins?: readonly string[];
  name?: string;
  maxBodyBytes?: number;
  maxEventClients?: number;
  heartbeatIntervalMs?: number;
};

export type StudioHttpPlugin = StudioPlugin & {
  address: () => StudioHttpPluginAddress | null;
  stop: () => Promise<void>;
};

export type InstalledStudioHttpPluginEnvironment = {
  workdir: string;
};

type EventClient = {
  stream: SSEStreamingApi;
  close: () => void;
};

class HttpRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function readPositiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function normalizeAllowedOrigins(origins: readonly string[] | undefined): Set<string> {
  const normalized = new Set<string>();
  for (const origin of origins ?? []) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`Studio HTTP Plugin allowed origin is invalid: ${origin}`);
    }
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || parsed.username
      || parsed.password
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash
    ) {
      throw new Error(`Studio HTTP Plugin allowed origin must be an HTTP(S) origin: ${origin}`);
    }
    normalized.add(parsed.origin);
  }
  return normalized;
}

function readOrigin(header: string | undefined): string | null | undefined {
  if (header === undefined) return undefined;
  if (!header.trim() || header === 'null') return null;
  try {
    const parsed = new URL(header);
    return parsed.origin === header ? header : null;
  } catch {
    return null;
  }
}

function readBearerToken(header: string | undefined): string | null {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function safeTokenEqual(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return providedBuffer.length === expectedBuffer.length
    && timingSafeEqual(providedBuffer, expectedBuffer);
}

function readRouteStatus(status: number | undefined): number {
  if (status === undefined) return 200;
  if (!Number.isSafeInteger(status) || status < 200 || status > 599) {
    throw new Error('Studio HTTP route status must be an integer from 200 to 599.');
  }
  return status;
}

function normalizeRoute(route: StudioHttpRoute): StudioHttpRoute {
  const method = route.method.trim().toUpperCase();
  if (method !== 'GET' && method !== 'POST') {
    throw new Error('Studio HTTP route method must be GET or POST.');
  }
  let parsed: URL;
  try {
    parsed = new URL(route.path, 'http://studio-http.local');
  } catch {
    throw new Error(`Studio HTTP route path is invalid: ${route.path}`);
  }
  if (
    !route.path.startsWith('/')
    || parsed.origin !== 'http://studio-http.local'
    || parsed.pathname !== route.path
    || parsed.search
    || parsed.hash
    || RESERVED_ROUTE_PATHS.has(parsed.pathname)
  ) {
    throw new Error(`Studio HTTP route must use an unreserved absolute path: ${route.path}`);
  }
  if (typeof route.handle !== 'function') {
    throw new Error('Studio HTTP route must define handle().');
  }
  return { ...route, method, path: parsed.pathname };
}

async function readJsonBody(context: StudioHttpContext): Promise<unknown> {
  const contentType = context.req.header('content-type');
  if (contentType?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    throw new HttpRequestError(415, 'Content-Type must be application/json.');
  }
  try {
    return await context.req.json();
  } catch {
    throw new HttpRequestError(400, 'Request body must contain valid JSON.');
  }
}

function noStoreHeaders(context: StudioHttpContext): void {
  context.header('X-Content-Type-Options', 'nosniff');
  context.header('Cache-Control', 'no-store');
}

function methodNotAllowed(context: StudioHttpContext, methods: readonly string[]) {
  context.header('Allow', [...methods, 'OPTIONS'].join(', '));
  return context.json({ error: 'Method not allowed.' }, 405);
}

function jsonResponse(context: StudioHttpContext, status: number, value: unknown): Response {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Studio HTTP JSON response is not serializable.');
  const headers = new Headers(context.res.headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(`${serialized}\n`, { status, headers });
}

function textResponse(
  context: StudioHttpContext,
  status: number,
  body: string,
  contentType: string,
): Response {
  const headers = new Headers(context.res.headers);
  headers.set('Content-Type', contentType);
  return new Response(body, { status, headers });
}

function listen(server: Server, port: number): Promise<StudioHttpPluginAddress> {
  return new Promise((resolve, reject) => {
    const handleError = (error: Error) => {
      server.off('listening', handleListening);
      reject(error);
    };
    const handleListening = () => {
      server.off('error', handleError);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Studio HTTP Plugin did not expose a TCP address.'));
        return;
      }
      resolve({ host: LOOPBACK_HOST, port: address.port });
    };
    server.once('error', handleError);
    server.once('listening', handleListening);
    server.listen(port, LOOPBACK_HOST);
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
        reject(error);
        return;
      }
      resolve();
    });
  });
  server.closeAllConnections();
  await closed;
}

/** Create a zero-Toolkit Plugin that projects Studio dispatch/event over loopback HTTP. */
export function createStudioHttpPlugin(options: CreateStudioHttpPluginOptions): StudioHttpPlugin {
  if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535) {
    throw new Error('Studio HTTP Plugin port must be an integer from 0 to 65535.');
  }
  if (!options.authToken.trim() || options.authToken.length < 16) {
    throw new Error('Studio HTTP Plugin authToken must contain at least 16 characters.');
  }
  const name = options.name?.trim() || 'http';
  const allowedOrigins = normalizeAllowedOrigins(options.allowedOrigins);
  const maxBodyBytes = readPositiveInteger(
    options.maxBodyBytes,
    DEFAULT_MAX_BODY_BYTES,
    'Studio HTTP Plugin maxBodyBytes',
  );
  const maxEventClients = readPositiveInteger(
    options.maxEventClients,
    DEFAULT_MAX_EVENT_CLIENTS,
    'Studio HTTP Plugin maxEventClients',
  );
  const heartbeatIntervalMs = readPositiveInteger(
    options.heartbeatIntervalMs,
    DEFAULT_HEARTBEAT_INTERVAL_MS,
    'Studio HTTP Plugin heartbeatIntervalMs',
  );

  let context: StudioPluginContext | undefined;
  let server: Server | undefined;
  let currentAddress: StudioHttpPluginAddress | null = null;
  let unsubscribeEvents: (() => void) | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let unexposeRoutes: (() => void) | undefined;
  let started = false;
  let stopped = false;
  const eventClients = new Set<EventClient>();
  const routes = new Map<string, StudioHttpRoute>();

  const routesHook: StudioHttpRoutesHook = {
    register: (input) => {
      const route = normalizeRoute(input);
      const key = `${route.method} ${route.path}`;
      if (routes.has(key)) throw new Error(`Duplicate Studio HTTP route: ${key}`);
      routes.set(key, route);
      return () => {
        if (routes.get(key) === route) routes.delete(key);
      };
    },
  };

  async function broadcastChunk(chunk: string): Promise<void> {
    await Promise.all([...eventClients].map(async (client) => {
      try {
        await client.stream.write(chunk);
      } catch {
        eventClients.delete(client);
        client.close();
      }
    }));
  }

  async function broadcastEvent(event: StudioEvent): Promise<void> {
    let data: string;
    try {
      data = JSON.stringify(event);
    } catch (error) {
      console.error(
        '[studio-http] event serialization failed:',
        error instanceof Error ? error.message : error,
      );
      return;
    }
    await broadcastChunk(`event: studio.event\ndata: ${data}\n\n`);
  }

  function createApp(): Hono<StudioHttpEnvironment> {
    const app = new Hono<StudioHttpEnvironment>();

    app.use('*', async (requestContext, next) => {
      noStoreHeaders(requestContext);
      await next();
    });
    app.use('*', async (requestContext, next) => {
      const origin = readOrigin(requestContext.req.header('origin'));
      if (origin === null || (origin !== undefined && !allowedOrigins.has(origin))) {
        return requestContext.json({ error: 'Origin is not allowed.' }, 403);
      }
      await next();
    });
    app.use('*', cors({
      origin: (origin) => allowedOrigins.has(origin) ? origin : undefined,
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type'],
      maxAge: 600,
    }));
    app.use('*', async (requestContext, next) => {
      const providedToken = readBearerToken(requestContext.req.header('authorization'));
      if (!providedToken || !safeTokenEqual(providedToken, options.authToken)) {
        requestContext.header('WWW-Authenticate', 'Bearer');
        return requestContext.json({ error: 'Unauthorized.' }, 401);
      }
      await next();
    });
    app.use('*', bodyLimit({
      maxSize: maxBodyBytes,
      onError: (requestContext) => requestContext.json(
        { error: `Request body exceeds ${maxBodyBytes.toString()} bytes.` },
        413,
      ),
    }));

    app.post('/dispatch', async (requestContext) => {
      const parsed = parseStudioDispatchRequest(await readJsonBody(requestContext));
      if (!parsed) throw new HttpRequestError(400, 'Invalid Studio dispatch request.');
      if (!context) throw new HttpRequestError(503, 'Studio HTTP Plugin is not running.');
      try {
        const receipt = await context.dispatch(parsed);
        return requestContext.json({
          petId: receipt.petId,
          invocationId: receipt.invocationId,
          ...(receipt.metadata ? { metadata: receipt.metadata } : {}),
        }, 202);
      } catch (error) {
        throw new HttpRequestError(
          422,
          error instanceof Error ? error.message : String(error),
        );
      }
    });
    app.all('/dispatch', (requestContext) => methodNotAllowed(requestContext, ['POST']));

    app.get('/pets', (requestContext) => {
      if (!context) throw new HttpRequestError(503, 'Studio HTTP Plugin is not running.');
      return requestContext.json({ pets: context.listPets() });
    });
    app.all('/pets', (requestContext) => methodNotAllowed(requestContext, ['GET']));

    app.get('/events', (requestContext) => {
      if (eventClients.size >= maxEventClients) {
        return requestContext.json({ error: 'Too many event clients.' }, 503);
      }
      const response = streamSSE(requestContext, async (stream) => {
        let resolveClosed: (() => void) | undefined;
        const closed = new Promise<void>((resolve) => {
          resolveClosed = resolve;
        });
        const close = () => resolveClosed?.();
        const client: EventClient = { stream, close };
        const abort = () => close();
        eventClients.add(client);
        requestContext.req.raw.signal.addEventListener('abort', abort, { once: true });
        try {
          await stream.write('retry: 3000\n: connected\n\n');
          await closed;
        } finally {
          requestContext.req.raw.signal.removeEventListener('abort', abort);
          eventClients.delete(client);
        }
      });
      response.headers.set('Cache-Control', 'no-cache, no-transform');
      response.headers.set('X-Accel-Buffering', 'no');
      return response;
    });
    app.all('/events', (requestContext) => methodNotAllowed(requestContext, ['GET']));

    app.all('*', async (requestContext) => {
      const route = routes.get(`${requestContext.req.method} ${requestContext.req.path}`);
      if (route) {
        let body: Promise<unknown> | undefined;
        const result = await route.handle({
          url: new URL(requestContext.req.url),
          headers: requestContext.env.incoming.headers,
          readJson: () => {
            body ??= readJsonBody(requestContext);
            return body;
          },
        });
        const status = readRouteStatus(result.status);
        if (result.kind === 'json') return jsonResponse(requestContext, status, result.body);
        if (result.kind === 'text') {
          return textResponse(
            requestContext,
            status,
            result.body,
            result.contentType ?? 'text/plain; charset=utf-8',
          );
        }
        throw new Error('Studio HTTP route returned an invalid result.');
      }

      const allowedMethods = [...routes.values()]
        .filter(({ path }) => path === requestContext.req.path)
        .map(({ method }) => method);
      if (allowedMethods.length > 0) return methodNotAllowed(requestContext, [...new Set(allowedMethods)]);
      return requestContext.json({ error: 'Not found.' }, 404);
    });

    app.onError((error, requestContext) => {
      const requestError = error instanceof HttpRequestError
        ? error
        : new HttpRequestError(500, 'Internal server error.');
      return jsonResponse(requestContext, requestError.status, { error: requestError.message });
    });
    return app;
  }

  return {
    name,
    toolkits: [],
    address: () => currentAddress ? { ...currentAddress } : null,
    start: async (pluginContext) => {
      if (started || stopped) throw new Error('Studio HTTP Plugin can only be started once.');
      started = true;
      context = pluginContext;
      const app = createApp();
      const nextServer = createServer(getRequestListener(app.fetch));
      nextServer.requestTimeout = 15_000;
      nextServer.headersTimeout = 10_000;
      nextServer.keepAliveTimeout = 5_000;
      server = nextServer;
      try {
        unexposeRoutes = pluginContext.hooks.expose(
          STUDIO_HTTP_ROUTES_HOOK_NAME,
          routesHook,
        );
        currentAddress = await listen(nextServer, options.port);
        unsubscribeEvents = pluginContext.subscribe(broadcastEvent);
        heartbeat = setInterval(() => {
          void broadcastChunk(': heartbeat\n\n');
        }, heartbeatIntervalMs);
        heartbeat.unref();
      } catch (error) {
        unexposeRoutes?.();
        unexposeRoutes = undefined;
        context = undefined;
        currentAddress = null;
        await closeServer(nextServer).catch(() => undefined);
        server = undefined;
        throw error;
      }
    },
    stop: async () => {
      if (stopped) return;
      stopped = true;
      unexposeRoutes?.();
      unexposeRoutes = undefined;
      routes.clear();
      unsubscribeEvents?.();
      unsubscribeEvents = undefined;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = undefined;
      for (const client of eventClients) client.close();
      eventClients.clear();
      const activeServer = server;
      server = undefined;
      currentAddress = null;
      context = undefined;
      if (activeServer) await closeServer(activeServer);
    },
  };
}

function readInstalledHttpOptions(
  value: Record<string, unknown> | undefined,
): Omit<CreateStudioHttpPluginOptions, 'authToken'> {
  const options = value ?? {};
  const allowed = new Set([
    'port',
    'allowedOrigins',
    'name',
    'maxBodyBytes',
    'maxEventClients',
    'heartbeatIntervalMs',
  ]);
  const unknown = Object.keys(options).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`Studio HTTP Plugin option "${unknown}" is not supported.`);
  const numbers = ['port', 'maxBodyBytes', 'maxEventClients', 'heartbeatIntervalMs'] as const;
  for (const field of numbers) {
    if (options[field] !== undefined && typeof options[field] !== 'number') {
      throw new Error(`Studio HTTP Plugin option "${field}" must be a number.`);
    }
  }
  if (options.name !== undefined && typeof options.name !== 'string') {
    throw new Error('Studio HTTP Plugin option "name" must be a string.');
  }
  if (
    options.allowedOrigins !== undefined
    && (!Array.isArray(options.allowedOrigins)
      || options.allowedOrigins.some((origin) => typeof origin !== 'string'))
  ) {
    throw new Error('Studio HTTP Plugin option "allowedOrigins" must be a string array.');
  }
  return {
    port: (options.port as number | undefined) ?? 3211,
    ...(options.allowedOrigins
      ? { allowedOrigins: options.allowedOrigins as string[] }
      : {}),
    ...(typeof options.name === 'string' ? { name: options.name } : {}),
    ...(typeof options.maxBodyBytes === 'number' ? { maxBodyBytes: options.maxBodyBytes } : {}),
    ...(typeof options.maxEventClients === 'number'
      ? { maxEventClients: options.maxEventClients }
      : {}),
    ...(typeof options.heartbeatIntervalMs === 'number'
      ? { heartbeatIntervalMs: options.heartbeatIntervalMs }
      : {}),
  };
}

/** Installed-package entry used by the standalone Studio Plugin resolver. */
export function createStudioPlugin(
  options: Record<string, unknown> | undefined,
  _environment: InstalledStudioHttpPluginEnvironment,
): StudioHttpPlugin {
  const authToken = readLocalServerAuthToken();
  if (!authToken) {
    throw new Error('Studio HTTP Plugin requires the Host local auth token.');
  }
  return createStudioHttpPlugin({
    ...readInstalledHttpOptions(options),
    authToken,
  });
}
