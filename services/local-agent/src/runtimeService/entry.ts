import { readFile, lstat, unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import lockfile from 'proper-lockfile';
import { createCdpRuntime, type CdpRuntimeConfig } from '@pinpawo-toolkit/browser';
import { createShellEnvironment } from '../toolkits/local/shellEnvironment';
import { loadRuntimeServiceConfig, runtimeServicePaths } from './config';
import { startRuntimeService } from './server';
import { RuntimeClient } from './client';
import { ensureRuntimeEndpointDirectory } from './endpoint';
import { RuntimeServiceError, record } from './protocol';
import type { RuntimeInstance, RuntimeFactory, RuntimeInstanceConfig, RuntimeCallContext } from './types';

async function main() {
  const index = process.argv.indexOf('--directory');
  if (index < 0 || !process.argv[index + 1]) throw new Error('Runtime service requires --directory.');
  const paths = runtimeServicePaths(process.argv[index + 1]);
  await ensureRuntimeEndpointDirectory(paths.endpoint);
  const token = (await readFile(paths.token, 'utf8')).trim();
  const endpointIsActive = async () => {
    try {
      const client = await RuntimeClient.connect({ endpoint: paths.endpoint, token, requirements: {} });
      await client.close();
      return true;
    } catch (error) {
      if (['ENOENT', 'ECONNREFUSED'].includes(String((error as NodeJS.ErrnoException).code))) return false;
      // A live endpoint with failed authentication/protocol must never be replaced.
      throw error;
    }
  };
  let compromised = false;
  let stop: (() => void) | undefined;
  let release: (() => Promise<void>) | undefined;
  const deadline = Date.now() + 25_000;
  while (!release && Date.now() < deadline) {
    try {
      release = await lockfile.lock(paths.root, {
        lockfilePath: paths.lock, stale: 10_000, update: 2000, retries: 0,
        onCompromised: () => {
          compromised = true;
          process.stderr.write('[runtime] Service ownership lock lost; shutting down.\n');
          stop?.();
        },
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ELOCKED') throw error;
      if (await endpointIsActive()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (!release) throw new RuntimeServiceError('startup_locked', 'Runtime service ownership could not be established.');
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => {
    cleanupPromise ??= compromised ? Promise.resolve() : release!();
    return cleanupPromise;
  };
  try {
    // A reachable endpoint remains authoritative even after a lock was removed.
    if (await endpointIsActive()) { await cleanup(); return; }
    if (compromised) throw new RuntimeServiceError('lock_lost', 'Runtime service ownership was lost during startup.');
    if (process.platform !== 'win32') {
      try {
        const stat = await lstat(paths.endpoint);
        if (!stat.isSocket() || (process.getuid && stat.uid !== process.getuid())) {
          throw new RuntimeServiceError('invalid_endpoint', 'Refusing to replace a Runtime endpoint not owned by this user.');
        }
        await unlink(paths.endpoint);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const config = await loadRuntimeServiceConfig(paths.config);
    const factories: Record<string, RuntimeFactory> = Object.assign(Object.create(null), {
      shell: createShellEnvironment,
      cdp: (config: RuntimeInstanceConfig): RuntimeInstance => {
        const runtime = createCdpRuntime(config as CdpRuntimeConfig);
        return {
          call: async (method: string, args: unknown, context: RuntimeCallContext) => {
            if (!Array.isArray(args) || !context.execution.threadId || !context.execution.workdir) {
              throw new RuntimeServiceError('invalid_request', 'CDP requires parameter arrays and a thread workdir.');
            }
            return runtime.call(method, args, { ...context, execution: {
              ...context.execution, threadId: context.execution.threadId, workdir: context.execution.workdir,
            } });
          },
          releaseClient: (id: string) => runtime.releaseClient(id),
          close: () => runtime.close(),
          diagnose: () => runtime.diagnose(),
        };
      },
    });
    for (const modulePath of config.modules ?? []) {
      const module = await import(pathToFileURL(modulePath).href) as { runtimeFactories?: unknown };
      for (const [type, factory] of Object.entries(record(module.runtimeFactories))) {
        if (Object.hasOwn(factories, type) || typeof factory !== 'function') {
          throw new RuntimeServiceError('invalid_module', 'Duplicate or invalid Runtime factory: ' + type);
        }
        factories[type] = factory as RuntimeFactory;
      }
    }
    if (compromised) throw new RuntimeServiceError('lock_lost', 'Runtime service ownership was lost during initialization.');
    const service = await startRuntimeService({
      endpoint: paths.endpoint, token, config, factories, onStopped: cleanup,
    });
    let shutdown: Promise<void> | undefined;
    stop = () => {
      shutdown ??= service.stop().finally(cleanup);
      void shutdown.catch(() => { process.exitCode = 1; });
    };
    if (compromised) stop();
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  } catch (error) {
    await cleanup();
    throw error;
  }
}

main().catch((error: unknown) => {
  process.stderr.write('[runtime] ' + (error instanceof Error ? error.message : 'Service startup failed.') + '\n');
  process.exitCode = 1;
});
