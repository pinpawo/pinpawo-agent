import { timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

import {
  parseStudioDispatchRequest,
  type StudioEvent,
  type StudioPlugin,
  type StudioPluginContext,
} from '@pinpawo/studio';

const LOOPBACK_HOST = '127.0.0.1' as const;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_MAX_EVENT_CLIENTS = 100;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

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

class HttpRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpRequestError';
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

function readOrigin(request: IncomingMessage): string | null | undefined {
  const origin = request.headers.origin;
  if (origin === undefined) return undefined;
  if (Array.isArray(origin) || !origin.trim() || origin === 'null') return null;
  try {
    const parsed = new URL(origin);
    return parsed.origin === origin ? origin : null;
  } catch {
    return null;
  }
}

function readBearerToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  if (Array.isArray(authorization)) return null;
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function safeTokenEqual(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return providedBuffer.length === expectedBuffer.length
    && timingSafeEqual(providedBuffer, expectedBuffer);
}

function applyCommonHeaders(response: ServerResponse): void {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cache-Control', 'no-store');
}

function applyCorsHeaders(response: ServerResponse, origin: string | undefined): void {
  if (!origin) return;
  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Vary', 'Origin');
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  const body = `${JSON.stringify(value)}\n`;
  applyCommonHeaders(response);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const contentType = request.headers['content-type'];
  if (
    Array.isArray(contentType)
    || contentType?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json'
  ) {
    throw new HttpRequestError(415, 'Content-Type must be application/json.');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) {
      throw new HttpRequestError(413, `Request body exceeds ${maxBytes.toString()} bytes.`);
    }
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpRequestError(400, 'Request body must contain valid JSON.');
  }
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
  let started = false;
  let stopped = false;
  const eventClients = new Set<ServerResponse>();

  function broadcastChunk(chunk: string): void {
    for (const client of eventClients) {
      if (client.destroyed || !client.write(chunk)) {
        eventClients.delete(client);
        client.end();
      }
    }
  }

  function broadcastEvent(event: StudioEvent): void {
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
    broadcastChunk(`event: studio.event\ndata: ${data}\n\n`);
  }

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestUrl = new URL(request.url ?? '/', 'http://studio-http.local');
    const origin = readOrigin(request);
    if (origin === null || (origin !== undefined && !allowedOrigins.has(origin))) {
      sendJson(response, 403, { error: 'Origin is not allowed.' });
      return;
    }
    applyCorsHeaders(response, origin);

    if (request.method === 'OPTIONS') {
      applyCommonHeaders(response);
      response.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '600',
      });
      response.end();
      return;
    }

    const providedToken = readBearerToken(request);
    if (!providedToken || !safeTokenEqual(providedToken, options.authToken)) {
      response.setHeader('WWW-Authenticate', 'Bearer');
      sendJson(response, 401, { error: 'Unauthorized.' });
      return;
    }

    if (requestUrl.pathname === '/dispatch') {
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST, OPTIONS');
        sendJson(response, 405, { error: 'Method not allowed.' });
        return;
      }
      const parsed = parseStudioDispatchRequest(await readJsonBody(request, maxBodyBytes));
      if (!parsed) throw new HttpRequestError(400, 'Invalid Studio dispatch request.');
      if (!context) throw new HttpRequestError(503, 'Studio HTTP Plugin is not running.');
      try {
        const receipt = await context.dispatch(parsed);
        sendJson(response, 202, {
          petId: receipt.petId,
          threadId: receipt.threadId,
          invocationId: receipt.invocationId,
          ...(receipt.metadata ? { metadata: receipt.metadata } : {}),
        });
      } catch (error) {
        throw new HttpRequestError(
          422,
          error instanceof Error ? error.message : String(error),
        );
      }
      return;
    }

    if (requestUrl.pathname === '/events') {
      if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET, OPTIONS');
        sendJson(response, 405, { error: 'Method not allowed.' });
        return;
      }
      if (eventClients.size >= maxEventClients) {
        sendJson(response, 503, { error: 'Too many event clients.' });
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      response.flushHeaders();
      response.socket?.setTimeout(0);
      eventClients.add(response);
      response.on('close', () => eventClients.delete(response));
      response.write('retry: 3000\n: connected\n\n');
      return;
    }

    sendJson(response, 404, { error: 'Not found.' });
  }

  return {
    name,
    toolkits: [],
    address: () => currentAddress ? { ...currentAddress } : null,
    start: async (pluginContext) => {
      if (started || stopped) throw new Error('Studio HTTP Plugin can only be started once.');
      started = true;
      context = pluginContext;
      const nextServer = createServer((request, response) => {
        void handleRequest(request, response).catch((error) => {
          const requestError = error instanceof HttpRequestError
            ? error
            : new HttpRequestError(500, 'Internal server error.');
          if (!response.headersSent) {
            sendJson(response, requestError.status, { error: requestError.message });
          } else {
            response.destroy(error instanceof Error ? error : undefined);
          }
        });
      });
      nextServer.requestTimeout = 15_000;
      nextServer.headersTimeout = 10_000;
      nextServer.keepAliveTimeout = 5_000;
      server = nextServer;
      try {
        currentAddress = await listen(nextServer, options.port);
        unsubscribeEvents = pluginContext.subscribe(broadcastEvent);
        heartbeat = setInterval(() => broadcastChunk(': heartbeat\n\n'), heartbeatIntervalMs);
        heartbeat.unref();
      } catch (error) {
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
      unsubscribeEvents?.();
      unsubscribeEvents = undefined;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = undefined;
      for (const client of eventClients) client.end();
      eventClients.clear();
      const activeServer = server;
      server = undefined;
      currentAddress = null;
      context = undefined;
      if (activeServer) await closeServer(activeServer);
    },
  };
}
