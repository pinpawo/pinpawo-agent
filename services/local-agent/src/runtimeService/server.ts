import { randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { isAbsolute } from 'node:path';
import { ensureRuntimeEndpointDirectory } from './endpoint';
import {
  RUNTIME_PROTOCOL_VERSION, RuntimeServiceError, receive, record, send, string,
} from './protocol';
import type { HostedRuntime, RuntimeExecution, RuntimeFactory, RuntimeServiceConfig } from './types';

type Instance = {
  value?: HostedRuntime;
  pending?: Promise<HostedRuntime>;
  failed?: string;
};

type Connection = {
  id: string;
  socket: Socket;
  authenticated: boolean;
  administrative: boolean;
  active: boolean;
  bindings: Map<string, string>;
  calls: Map<string, AbortController>;
};

function sameToken(left: unknown, right: string): boolean {
  return typeof left === 'string' && Buffer.byteLength(left) === Buffer.byteLength(right)
    && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function errorDetails(value: unknown): unknown {
  if (!value || typeof value !== 'object') return undefined;
  // Extension failures may contain circular objects or huge payloads. Preserve
  // small structured errors (including browser origin guards) without letting
  // a failure while serializing an error crash the shared service.
  try {
    const json = JSON.stringify(value);
    return json && Buffer.byteLength(json) <= 64 * 1024 ? JSON.parse(json) : undefined;
  } catch { return undefined; }
}

function executionScope(value: unknown): RuntimeExecution {
  const input = record(value);
  if (input.threadId !== null) string(input.threadId, 'threadId');
  string(input.taskId, 'taskId');
  string(input.runId, 'runId');
  string(input.delegationId, 'delegationId');
  if (input.workdir !== null && (typeof input.workdir !== 'string' || !isAbsolute(input.workdir))) {
    throw new RuntimeServiceError('invalid_workdir', 'Runtime workdir must be an absolute path.');
  }
  return {
    threadId: input.threadId as string | null,
    taskId: input.taskId as string,
    runId: input.runId as string,
    delegationId: input.delegationId as string,
    workdir: input.workdir as string | null,
  };
}

/** One service owns environment instances; connections own only their resources. */
export async function startRuntimeService(options: {
  endpoint: string;
  token: string;
  config: RuntimeServiceConfig;
  factories: Readonly<Record<string, RuntimeFactory>>;
  onStopped?: () => void | Promise<void>;
}) {
  await ensureRuntimeEndpointDirectory(options.endpoint);
  const instances = new Map<string, Instance>();
  const connections = new Set<Connection>();
  const cleanups = new Set<Promise<unknown>>();
  let stopping: Promise<void> | undefined;

  async function instance(id: string): Promise<HostedRuntime> {
    const config = options.config.instances[id];
    if (!config) throw new RuntimeServiceError('unknown_instance', `Unknown Runtime instance: ${id}`);
    let entry = instances.get(id);
    if (!entry) {
      entry = {};
      instances.set(id, entry);
    }
    if (entry.failed) throw new RuntimeServiceError('runtime_unavailable', entry.failed);
    if (entry.value) return entry.value;
    if (!entry.pending) {
      const factory = options.factories[config.type];
      if (!factory) throw new RuntimeServiceError('unknown_runtime_type', `Unregistered Runtime type: ${config.type}`);
      const target = entry;
      target.pending = Promise.resolve().then(() => factory(config)).then((value) => {
        target.value = value;
        return value;
      }, (error: unknown) => {
        target.failed = error instanceof Error ? error.message : 'Runtime initialization failed.';
        throw new RuntimeServiceError('runtime_unavailable', target.failed);
      });
    }
    return entry.pending!;
  }

  async function releaseClient(client: Connection): Promise<void> {
    const results = await Promise.allSettled([...instances.values()].map(async (entry) => {
      const runtime = entry.value ?? await entry.pending;
      await runtime?.releaseClient(client.id);
    }));
    if (results.some((result) => result.status === 'rejected')) {
      // Never print command arguments, environment values or plugin payloads.
      process.stderr.write('[runtime] Client resource cleanup could not be fully confirmed.\n');
    }
  }

  function disconnect(client: Connection): void {
    if (!client.active) return;
    client.active = false;
    connections.delete(client);
    for (const controller of client.calls.values()) controller.abort();
    const cleanup = releaseClient(client);
    cleanups.add(cleanup);
    void cleanup.finally(() => cleanups.delete(cleanup));
  }

  async function status(client: Connection) {
    const ids = client.administrative
      ? Object.keys(options.config.instances)
      : [...new Set(client.bindings.values())];
    return {
      pid: process.pid,
      protocol: RUNTIME_PROTOCOL_VERSION,
      instances: await Promise.all(ids.map(async (id) => {
        const entry = instances.get(id);
        return {
          instanceId: id,
          type: options.config.instances[id]?.type,
          state: entry?.failed ? 'failed' : entry?.value ? 'ready' : entry?.pending ? 'starting' : 'idle',
          ...(entry?.failed ? { error: entry.failed } : {}),
          // Instance diagnostics are aggregate state only, never other clients' resources.
          ...(entry?.value ? { details: await entry.value.diagnose() } : {}),
        };
      })),
    };
  }

  const server = createServer((socket) => {
    if (stopping || connections.size >= 64) { socket.destroy(); return; }
    const client: Connection = {
      id: randomUUID(), socket, authenticated: false, administrative: false,
      active: true, bindings: new Map(), calls: new Map(),
    };
    connections.add(client);
    const handshakeTimer = setTimeout(() => {
      if (!client.authenticated) socket.destroy();
    }, 5000);
    handshakeTimer.unref();
    socket.on('error', () => { /* close owns cleanup */ });
    socket.on('close', () => { clearTimeout(handshakeTimer); disconnect(client); });

    receive(socket, (message) => {
      if (!client.active) return;
      if (message.op === 'cancel') {
        if (!client.authenticated) { socket.destroy(); return; }
        client.calls.get(string(message.requestId, 'requestId'))?.abort();
        return;
      }
      const id = string(message.id, 'id');
      if (client.calls.has(id) || client.calls.size >= 128) { socket.destroy(); return; }
      const controller = new AbortController();
      client.calls.set(id, controller);
      void (async () => {
        if (!client.authenticated) {
          if (message.op !== 'hello' || !sameToken(message.token, options.token)) {
            throw new RuntimeServiceError('authentication_failed', 'Runtime authentication failed.');
          }
          if (message.protocol !== RUNTIME_PROTOCOL_VERSION) {
            throw new RuntimeServiceError('protocol_mismatch', 'Runtime protocol mismatch; restart with matching client and service versions.');
          }
          const requested = record(message.toolkits);
          const bindings: Record<string, { instanceId: string; runtimeType: string }> = Object.create(null);
          for (const [toolkit, type] of Object.entries(requested)) {
            string(type, 'runtimeType');
            const instanceId = options.config.toolkitBindings[toolkit];
            const config = instanceId ? options.config.instances[instanceId] : undefined;
            if (!config || config.type !== type || !Object.hasOwn(options.factories, config.type)) {
              throw new RuntimeServiceError('binding_mismatch', `No compatible configured Runtime for Toolkit: ${toolkit}`);
            }
            client.bindings.set(toolkit, instanceId);
            bindings[toolkit] = { instanceId, runtimeType: config.type };
          }
          client.authenticated = true;
          client.administrative = message.administrative === true;
          clearTimeout(handshakeTimer);
          return { clientId: client.id, pid: process.pid, bindings };
        }
        if (message.op === 'status') return status(client);
        if (message.op === 'stop') {
          if (!client.administrative) throw new RuntimeServiceError('forbidden', 'Only an explicit management connection can stop the service.');
          setImmediate(() => { void stop().catch(() => {
            process.stderr.write('[runtime] Service stopped with unconfirmed resource cleanup.\n');
            process.exitCode = 1;
          }); });
          return { stopping: true };
        }
        if (message.op !== 'call') throw new RuntimeServiceError('invalid_request', 'Unknown Runtime operation.');
        const toolkitName = string(message.toolkitName, 'toolkitName');
        const instanceId = client.bindings.get(toolkitName);
        if (!instanceId) throw new RuntimeServiceError('forbidden', 'Toolkit is not bound on this connection.');
        const method = string(message.method, 'method');
        const execution = executionScope(message.execution);
        const runtime = await instance(instanceId);
        if (!client.active || controller.signal.aborted) throw new RuntimeServiceError('aborted', 'Runtime operation cancelled before execution.');
        try {
          return await runtime.call(method, message.args, {
            clientId: client.id, toolkitName, execution, signal: controller.signal,
          });
        } finally {
          // A resource created concurrently with disconnect must not escape cleanup.
          if (!client.active) await runtime.releaseClient(client.id);
        }
      })().then((value) => {
        send(socket, { id, ok: true, value: value ?? null });
      }).catch((error: unknown) => {
        const payload = error && typeof error === 'object' ? error as Record<string, unknown> : {};
        send(socket, { id, ok: false, error: {
          code: typeof payload.code === 'string' ? payload.code.slice(0, 256) : 'runtime_error',
          name: error instanceof Error ? error.name.slice(0, 256) : 'Error',
          message: error instanceof Error ? error.message.slice(0, 4096) : 'Runtime operation failed.',
          ...(typeof payload.retryable === 'boolean' ? { retryable: payload.retryable } : {}),
          details: errorDetails(payload.details),
        } });
        if (!client.authenticated) socket.end();
      }).catch(() => socket.destroy()).finally(() => client.calls.delete(id));
    });
  });

  async function stop(): Promise<void> {
    if (stopping) return stopping;
    stopping = (async () => {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const client of connections) {
        disconnect(client);
        client.socket.destroy();
      }
      await Promise.allSettled([...cleanups]);
      const results = await Promise.allSettled([...instances.values()].map(async (entry) => {
        const runtime = entry.value ?? await entry.pending;
        await runtime?.close();
      }));
      await closed;
      await options.onStopped?.();
      if (results.some((result) => result.status === 'rejected')) {
        throw new RuntimeServiceError('cleanup_failed', 'Runtime resource cleanup could not be fully confirmed.');
      }
    })();
    return stopping;
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.endpoint, () => {
      server.off('error', reject);
      resolve();
    });
  });
  if (process.platform !== 'win32') await chmod(options.endpoint, 0o600);
  return { stop };
}
