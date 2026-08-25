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
  type StudioDispatchInput,
  type StudioEvent,
  type StudioInvocationEvent,
  type StudioPlugin,
  type StudioPluginContext,
} from '@pinpawo/studio';

const LOOPBACK_HOST = '127.0.0.1' as const;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_MAX_EVENT_CLIENTS = 100;
const DEFAULT_MAX_DISPATCH_RECORDS = 500;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
export const STUDIO_HTTP_ROUTES_HOOK_NAME = 'routes';
export const STUDIO_HTTP_STATIC_HOOK_NAME = 'static';
const RESERVED_ROUTE_PATHS = new Set(['/dispatch', '/dispatches', '/events', '/pets']);
const MAX_STATIC_ASSET_BYTES = 10 * 1024 * 1024;

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

/** One packaged static asset. Providers never receive a filesystem path. */
export type StudioHttpStaticAsset = {
  body: Uint8Array;
  contentType: string;
  cacheControl?: string;
};

/** A Plugin-owned, pre-packaged static bundle mounted by the HTTP Plugin. */
export type StudioHttpStaticMount = {
  mountPath: string;
  resolve: (relativePath: string) => StudioHttpStaticAsset | undefined | Promise<StudioHttpStaticAsset | undefined>;
  fallback?: 'index.html';
};

export type StudioHttpStaticHook = {
  register: (mount: StudioHttpStaticMount) => () => void;
};

export type StudioHttpPluginAddress = {
  readonly host: typeof LOOPBACK_HOST;
  readonly port: number;
};

export type StudioHttpDispatchInput =
  | { kind: 'request'; request: string }
  | { kind: 'resume'; continuationId: string };

/** In-memory read model for dispatches accepted through this HTTP Plugin. */
export type StudioHttpDispatchRecord = {
  readonly petId: string;
  readonly threadId: string;
  readonly invocationId: string;
  readonly input: StudioHttpDispatchInput;
  readonly status: 'queued' | StudioInvocationEvent['status'];
  readonly submittedAt: string;
  readonly updatedAt: string;
  readonly output?: string;
  readonly pendingContinuation?: StudioInvocationEvent['pendingContinuation'];
  readonly error?: string;
};

export type CreateStudioHttpPluginOptions = {
  /** `0` asks the OS for an ephemeral port. */
  port: number;
  /** Optional Bearer token for dispatch, events, and contributed routes. */
  authToken?: string;
  /** Exact HTTP(S) origins allowed to call the Plugin from a browser. */
  allowedOrigins?: readonly string[];
  name?: string;
  maxBodyBytes?: number;
  maxEventClients?: number;
  maxDispatchRecords?: number;
  heartbeatIntervalMs?: number;
};

export type StudioHttpPlugin = StudioPlugin & {
  address: () => StudioHttpPluginAddress | null;
  stop: () => Promise<void>;
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

function isTerminalInvocationStatus(status: StudioInvocationEvent['status']): boolean {
  return status === 'completed'
    || status === 'waiting'
    || status === 'failed'
    || status === 'cancelled';
}

function projectDispatchInput(
  input: StudioDispatchInput,
): StudioHttpDispatchInput {
  return input.kind === 'request'
    ? { kind: 'request', request: input.request }
    : { kind: 'resume', continuationId: input.continuationId };
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

function normalizeStaticMount(input: StudioHttpStaticMount): StudioHttpStaticMount {
  const mountPath = input.mountPath;
  if (
    typeof mountPath !== 'string'
    || !mountPath.startsWith('/')
    || (mountPath.length > 1 && mountPath.endsWith('/'))
    || mountPath.includes('?')
    || mountPath.includes('#')
    || mountPath.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    throw new Error('Studio HTTP static mount path must be an absolute normalized path.');
  }
  if (RESERVED_ROUTE_PATHS.has(mountPath) || typeof input.resolve !== 'function') {
    throw new Error('Studio HTTP static mount must use an unreserved path and define resolve().');
  }
  if (input.fallback !== undefined && input.fallback !== 'index.html') {
    throw new Error('Studio HTTP static mount fallback must be "index.html" when present.');
  }
  return { ...input, mountPath };
}

function validateStaticAsset(asset: StudioHttpStaticAsset, mountPath: string): StudioHttpStaticAsset {
  if (!(asset.body instanceof Uint8Array) || asset.body.byteLength > MAX_STATIC_ASSET_BYTES) {
    throw new Error(`Studio HTTP static mount "${mountPath}" returned an invalid asset body.`);
  }
  if (typeof asset.contentType !== 'string' || !asset.contentType.trim()) {
    throw new Error(`Studio HTTP static mount "${mountPath}" returned an invalid content type.`);
  }
  if (asset.cacheControl !== undefined && (typeof asset.cacheControl !== 'string' || !asset.cacheControl.trim())) {
    throw new Error(`Studio HTTP static mount "${mountPath}" returned an invalid cache policy.`);
  }
  return asset;
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

function staticResponse(
  context: StudioHttpContext,
  asset: StudioHttpStaticAsset,
): Response {
  context.header('Cache-Control', asset.cacheControl ?? 'no-store');
  const headers = new Headers(context.res.headers);
  headers.set('Content-Type', asset.contentType);
  headers.set('Cache-Control', asset.cacheControl ?? 'no-store');
  const body = new Uint8Array(asset.body.byteLength);
  body.set(asset.body);
  return new Response(body.buffer, { status: 200, headers });
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
  if (options.authToken !== undefined
    && (!options.authToken.trim() || options.authToken.length < 16)) {
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
  const maxDispatchRecords = readPositiveInteger(
    options.maxDispatchRecords,
    DEFAULT_MAX_DISPATCH_RECORDS,
    'Studio HTTP Plugin maxDispatchRecords',
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
  const dispatchRecords = new Map<string, StudioHttpDispatchRecord>();
  const dispatchSubscriptions = new Set<() => void>();
  const routes = new Map<string, StudioHttpRoute>();
  const staticMounts = new Map<string, StudioHttpStaticMount>();

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

  const staticHook: StudioHttpStaticHook = {
    register: (input) => {
      const mount = normalizeStaticMount(input);
      if (staticMounts.has(mount.mountPath)) {
        throw new Error(`Duplicate Studio HTTP static mount: ${mount.mountPath}`);
      }
      staticMounts.set(mount.mountPath, mount);
      return () => {
        if (staticMounts.get(mount.mountPath) === mount) staticMounts.delete(mount.mountPath);
      };
    },
  };

  async function resolveStaticAsset(pathname: string): Promise<StudioHttpStaticAsset | undefined> {
    const mounts = [...staticMounts.values()].sort(
      (left, right) => right.mountPath.length - left.mountPath.length,
    );
    for (const mount of mounts) {
      const isRoot = mount.mountPath === '/';
      if (!isRoot && pathname !== mount.mountPath && !pathname.startsWith(`${mount.mountPath}/`)) {
        continue;
      }
      const relativePath = isRoot
        ? pathname.slice(1)
        : pathname.slice(mount.mountPath.length).replace(/^\//, '');
      const requested = relativePath || 'index.html';
      const direct = await mount.resolve(requested);
      if (direct) return validateStaticAsset(direct, mount.mountPath);
      if (mount.fallback === 'index.html') {
        const fallback = await mount.resolve('index.html');
        if (fallback) return validateStaticAsset(fallback, mount.mountPath);
      }
    }
    return undefined;
  }

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

  function pruneDispatchRecords(): void {
    if (dispatchRecords.size <= maxDispatchRecords) return;
    for (const [invocationId, record] of dispatchRecords) {
      if (record.status === 'queued' || record.status === 'busy') continue;
      dispatchRecords.delete(invocationId);
      if (dispatchRecords.size <= maxDispatchRecords) return;
    }
  }

  function publishDispatchRecord(record: StudioHttpDispatchRecord): void {
    dispatchRecords.set(record.invocationId, record);
    pruneDispatchRecords();
    void broadcastEvent({
      type: 'dispatch.updated',
      source: name,
      payload: { dispatch: record },
      occurredAt: record.updatedAt,
    });
  }

  function observeDispatch(
    receipt: Awaited<ReturnType<StudioPluginContext['dispatch']>>,
    input: StudioDispatchInput,
    submittedAt: string,
  ): void {
    // An idempotent HTTP retry may receive the same Studio receipt. Preserve
    // the existing lifecycle instead of briefly regressing it to queued.
    if (dispatchRecords.has(receipt.invocationId)) return;
    publishDispatchRecord({
      petId: receipt.petId,
      threadId: receipt.threadId,
      invocationId: receipt.invocationId,
      input: projectDispatchInput(input),
      status: 'queued',
      submittedAt,
      updatedAt: submittedAt,
    });

    let unsubscribe: () => void = () => undefined;
    let terminalBeforeRegistration = false;
    const release = () => {
      dispatchSubscriptions.delete(unsubscribe);
      unsubscribe();
    };
    unsubscribe = receipt.onInvocation((event) => {
      const previous = dispatchRecords.get(event.invocationId);
      const updatedAt = new Date().toISOString();
      publishDispatchRecord({
        petId: event.petId,
        threadId: event.threadId,
        invocationId: event.invocationId,
        input: previous?.input ?? projectDispatchInput(input),
        status: event.status,
        submittedAt: previous?.submittedAt ?? submittedAt,
        updatedAt,
        ...(event.output ? { output: event.output } : {}),
        ...(event.pendingContinuation
          ? { pendingContinuation: event.pendingContinuation }
          : {}),
        ...(event.error ? { error: event.error } : {}),
      });
      if (isTerminalInvocationStatus(event.status)) {
        terminalBeforeRegistration = true;
        queueMicrotask(release);
      }
    });
    if (!terminalBeforeRegistration) dispatchSubscriptions.add(unsubscribe);
  }

  function createApp(): Hono<StudioHttpEnvironment> {
    const app = new Hono<StudioHttpEnvironment>();
    const acceptsOrigin = (origin: string): boolean => (
      allowedOrigins.has(origin)
      || origin === `http://${LOOPBACK_HOST}:${currentAddress?.port.toString() ?? ''}`
    );

    app.use('*', async (requestContext, next) => {
      noStoreHeaders(requestContext);
      await next();
    });
    app.use('*', async (requestContext, next) => {
      const origin = readOrigin(requestContext.req.header('origin'));
      if (origin === null || (origin !== undefined && !acceptsOrigin(origin))) {
        return requestContext.json({ error: 'Origin is not allowed.' }, 403);
      }
      await next();
    });
    app.use('*', cors({
      origin: (origin) => acceptsOrigin(origin) ? origin : undefined,
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type'],
      maxAge: 600,
    }));
    app.use('*', async (requestContext, next) => {
      if (options.authToken === undefined) {
        await next();
        return;
      }
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
        const submittedAt = new Date().toISOString();
        const receipt = await context.dispatch(parsed);
        observeDispatch(receipt, parsed.input, submittedAt);
        return requestContext.json({
          petId: receipt.petId,
          threadId: receipt.threadId,
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

    app.get('/dispatches', (requestContext) => requestContext.json({
      dispatches: [...dispatchRecords.values()],
    }));
    app.all('/dispatches', (requestContext) => methodNotAllowed(requestContext, ['GET']));

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
      if (requestContext.req.method === 'GET' || requestContext.req.method === 'HEAD') {
        const asset = await resolveStaticAsset(requestContext.req.path);
        if (asset) return staticResponse(requestContext, asset);
      }
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
        const unexposeStatic = pluginContext.hooks.expose(
          STUDIO_HTTP_STATIC_HOOK_NAME,
          staticHook,
        );
        const previousUnexposeRoutes = unexposeRoutes;
        unexposeRoutes = () => {
          unexposeStatic();
          previousUnexposeRoutes();
        };
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
      staticMounts.clear();
      for (const unsubscribe of dispatchSubscriptions) unsubscribe();
      dispatchSubscriptions.clear();
      dispatchRecords.clear();
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
