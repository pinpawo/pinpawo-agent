import { timingSafeEqual } from 'node:crypto';
import { chmod } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import {
  asRecord,
  receiveFrames,
  RS_SERVICE_PROTOCOL_VERSION,
  RSServiceError,
  sendFrame,
  toWireError,
} from './transport';

/**
 * One RS contract served by the service.
 *
 * The framework never interprets `method`, `args` or results: each contract
 * owns its operations, their schema and their errors. A handler only has to
 * be reachable by contract name and version.
 */
export type RSServiceHandler = Readonly<{
  contract: string;
  version: number;
  call(method: string, args: unknown, context: RSCallContext): Promise<unknown>;
  /** Contract-specific management operations, reached through the admin channel. */
  manage?(action: string, args: unknown): Promise<unknown>;
  /** Contract-specific status details for `status`. */
  describe?(): Promise<Record<string, unknown>> | Record<string, unknown>;
  /** Whether stopping the service now would end work this handler holds. */
  busy?(): Promise<boolean> | boolean;
  /** End everything this handler holds; returns a report of what was cleaned up. */
  dispose(): Promise<Record<string, unknown>>;
}>;

export type RSCallContext = Readonly<{
  /** Aborted only by an explicit cancellation from the caller. */
  signal: AbortSignal;
}>;

export type RSServiceStatus = Readonly<{
  pid: number;
  startedAt: number;
  protocol: number;
  /** Identity of the code this service runs; see `rsServiceBuildId`. */
  build: string | null;
  /** Whether stopping it now would end work: running processes or unanswered calls. */
  busy: boolean;
  rs: readonly Readonly<{ contract: string; version: number; details: Record<string, unknown> }>[];
}>;

export type RSServiceStopReport = Readonly<{
  rs: readonly Readonly<{ contract: string; report?: Record<string, unknown>; error?: string }>[];
}>;

export type RunningRSService = Readonly<{
  /** Stop accepting work, dispose every handler, then close the endpoint. */
  stop(): Promise<RSServiceStopReport>;
  /** Resolves once the service has fully stopped, by `stop` or an admin request. */
  stopped: Promise<RSServiceStopReport>;
}>;

const HELLO_TIMEOUT_MS = 5_000;

function tokensMatch(expected: string, actual: unknown): boolean {
  if (typeof actual !== 'string') return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

type ConnectionState =
  | { kind: 'pending' }
  | { kind: 'rs'; handler: RSServiceHandler }
  | { kind: 'admin' };

/**
 * Listen on the endpoint and serve the given handlers.
 *
 * Every connection starts with `hello` carrying the token. A connection that
 * names an RS contract may call that contract; one that names none is an
 * admin connection. Closing a connection cancels nothing: work already
 * started keeps running and stays where its contract put it (for ShellRS, in
 * the Agent session). Only an explicit `cancel` aborts a request.
 */
export async function startRSService(options: Readonly<{
  endpoint: string;
  token: string;
  handlers: readonly RSServiceHandler[];
  build?: string;
  log?: (message: string) => void;
}>): Promise<RunningRSService> {
  const log = options.log ?? ((message: string) => process.stderr.write(`[rs] ${message}\n`));
  const handlers = new Map<string, RSServiceHandler>();
  for (const handler of options.handlers) {
    if (handlers.has(handler.contract)) {
      throw new Error(`Duplicate RS handler for contract "${handler.contract}"`);
    }
    handlers.set(handler.contract, handler);
  }
  const startedAt = Date.now();
  const build = options.build ?? null;
  const sockets = new Set<Socket>();
  let activeCalls = 0;
  let stopping: Promise<RSServiceStopReport> | null = null;
  let resolveStopped!: (report: RSServiceStopReport) => void;
  const stopped = new Promise<RSServiceStopReport>((resolvePromise) => {
    resolveStopped = resolvePromise;
  });

  const busy = async (): Promise<boolean> => {
    if (activeCalls > 0) return true;
    const handlerBusy = await Promise.all([...handlers.values()].map(async (handler) => (
      (await handler.busy?.()) ?? false
    )));
    return handlerBusy.some(Boolean);
  };

  const status = async (): Promise<RSServiceStatus> => ({
    pid: process.pid,
    startedAt,
    protocol: RS_SERVICE_PROTOCOL_VERSION,
    build,
    busy: await busy(),
    rs: await Promise.all([...handlers.values()].map(async (handler) => ({
      contract: handler.contract,
      version: handler.version,
      details: (await handler.describe?.()) ?? {},
    }))),
  });

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => { /* a broken peer only loses its own connection */ });
    let state: ConnectionState = { kind: 'pending' };
    const inFlight = new Map<string, AbortController>();
    const helloTimer = setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS);
    helloTimer.unref();

    const reply = (id: string, outcome: { ok: true; value: unknown } | { ok: false; error: unknown }) => {
      try {
        sendFrame(socket, outcome.ok
          ? { id, ok: true, value: outcome.value ?? null }
          : { id, ok: false, error: toWireError(outcome.error) });
      } catch (error) {
        // An oversized result is reported as an error rather than dropped.
        sendFrame(socket, { id, ok: false, error: toWireError(error) });
      }
    };

    receiveFrames(socket, (message) => {
      const op = message.op;
      const id = typeof message.id === 'string' ? message.id : '';

      if (state.kind === 'pending') {
        if (op !== 'hello' || !id) {
          socket.destroy();
          return;
        }
        clearTimeout(helloTimer);
        if (!tokensMatch(options.token, message.token)) {
          reply(id, { ok: false, error: new RSServiceError('unauthorized', 'RS service token was rejected.') });
          socket.end();
          return;
        }
        if (message.protocol !== RS_SERVICE_PROTOCOL_VERSION) {
          reply(id, {
            ok: false,
            error: new RSServiceError(
              'protocol_mismatch',
              `RS service speaks protocol ${RS_SERVICE_PROTOCOL_VERSION.toString()}, `
              + `client requested ${String(message.protocol)}. Restart the service with \`pinpawo rs stop\`.`,
            ),
          });
          socket.end();
          return;
        }
        if (stopping) {
          reply(id, { ok: false, error: new RSServiceError('stopping', 'RS service is stopping.') });
          socket.end();
          return;
        }
        if (message.rs === undefined) {
          state = { kind: 'admin' };
          reply(id, { ok: true, value: { pid: process.pid, build } });
          return;
        }
        let requested: Record<string, unknown>;
        try {
          requested = asRecord(message.rs, 'rs');
        } catch (error) {
          reply(id, { ok: false, error });
          socket.end();
          return;
        }
        const handler = handlers.get(String(requested.contract));
        if (!handler) {
          reply(id, {
            ok: false,
            error: new RSServiceError(
              'contract_unavailable',
              `RS service does not provide ${String(requested.contract)}.`,
            ),
          });
          socket.end();
          return;
        }
        if (handler.version !== requested.version) {
          reply(id, {
            ok: false,
            error: new RSServiceError(
              'contract_version_mismatch',
              `RS service provides ${handler.contract}@${handler.version.toString()}, `
              + `client requires @${String(requested.version)}. Restart the service with \`pinpawo rs stop\`.`,
            ),
          });
          socket.end();
          return;
        }
        state = { kind: 'rs', handler };
        reply(id, { ok: true, value: { pid: process.pid, build } });
        return;
      }

      if (op === 'cancel') {
        const requestId = typeof message.requestId === 'string' ? message.requestId : '';
        inFlight.get(requestId)?.abort();
        return;
      }
      if (!id) {
        socket.destroy();
        return;
      }
      if (stopping) {
        reply(id, { ok: false, error: new RSServiceError('stopping', 'RS service is stopping.') });
        return;
      }

      if (op === 'call' && state.kind === 'rs') {
        const { handler } = state;
        const controller = new AbortController();
        inFlight.set(id, controller);
        activeCalls += 1;
        void (async () => {
          try {
            const value = await handler.call(
              String(message.method),
              message.args,
              { signal: controller.signal },
            );
            reply(id, { ok: true, value });
          } catch (error) {
            reply(id, { ok: false, error });
          } finally {
            inFlight.delete(id);
            activeCalls -= 1;
          }
        })();
        return;
      }

      if (op === 'admin' && state.kind === 'admin') {
        void (async () => {
          try {
            reply(id, { ok: true, value: await runAdmin(message) });
          } catch (error) {
            reply(id, { ok: false, error });
          }
        })();
        return;
      }

      reply(id, { ok: false, error: new RSServiceError('invalid_request', `Unsupported operation: ${String(op)}`) });
    });
  });

  const runAdmin = async (message: Record<string, unknown>): Promise<unknown> => {
    const action = message.action;
    if (action === 'status') return await status();
    if (action === 'stop') {
      // Answer first; the requester learns the outcome from the report.
      const report = stop();
      return await report;
    }
    if (action === 'manage') {
      const handler = handlers.get(String(message.contract));
      if (!handler?.manage) {
        throw new RSServiceError('contract_unavailable', `No management for ${String(message.contract)}.`);
      }
      return await handler.manage(String(message.name), message.args);
    }
    throw new RSServiceError('invalid_request', `Unknown admin action: ${String(action)}`);
  };

  const stop = (): Promise<RSServiceStopReport> => {
    stopping ??= (async () => {
      server.close();
      const rs = await Promise.all([...handlers.values()].map(async (handler) => {
        try {
          return { contract: handler.contract, report: await handler.dispose() };
        } catch (error) {
          return {
            contract: handler.contract,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }));
      const report: RSServiceStopReport = { rs };
      // Let pending replies (including the stop report) flush before closing.
      setTimeout(() => {
        for (const socket of sockets) socket.destroy();
      }, 50).unref();
      log(`stopped: ${JSON.stringify(report)}`);
      resolveStopped(report);
      return report;
    })();
    return stopping;
  };

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(options.endpoint, () => {
      server.off('error', reject);
      resolvePromise();
    });
  });
  // The private directory is the boundary; the socket mode is defense in depth.
  await chmod(options.endpoint, 0o600);
  log(`listening on ${options.endpoint} (pid ${process.pid.toString()})`);

  return { stop, stopped };
}
