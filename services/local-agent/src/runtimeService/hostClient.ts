import type { ToolkitRuntimeRequirement, ConnectedToolkitRuntime } from '../toolkits/runtimeBinding';
import { BROWSER_RUNTIME_METHODS, type BrowserRuntimeCallContext, type BrowserRuntimePort } from '@pinpawo-toolkit/browser';
import { createShellRuntimeClient } from '../toolkits/local/shellClient';
import { ensureRuntimeService } from './launcher';
import { RuntimeServiceError } from './protocol';
import type { RuntimeClient } from './client';
import type { RuntimeCaller } from './types';

export type RuntimeClientFactory = (caller: RuntimeCaller, toolkitName: string) => unknown;

function createBrowserClient(caller: RuntimeCaller, toolkitName: string): BrowserRuntimePort {
  return Object.freeze(Object.fromEntries(BROWSER_RUNTIME_METHODS.map((method) => [
    method, (context: BrowserRuntimeCallContext, ...args: unknown[]) => {
      if (!context.taskId || !context.runId || !context.delegationId) {
        throw new Error('Browser Runtime requires a complete execution scope.');
      }
      return caller.call(toolkitName, method, args, {
        threadId: context.threadId, taskId: context.taskId, runId: context.runId,
        delegationId: context.delegationId, workdir: context.workdir,
      }, context.signal);
    },
  ]))) as BrowserRuntimePort;
}

export async function connectHostRuntimes(options: {
  requirements: readonly ToolkitRuntimeRequirement[];
  directory?: string;
  clientFactories?: Readonly<Record<string, RuntimeClientFactory>>;
}) {
  const factories: Record<string, RuntimeClientFactory> = Object.assign(Object.create(null), {
    shell: createShellRuntimeClient,
    cdp: createBrowserClient,
  });
  for (const [kind, factory] of Object.entries(options.clientFactories ?? {})) {
    if (Object.hasOwn(factories, kind)) throw new Error(`Duplicate Runtime client factory: ${kind}`);
    factories[kind] = factory;
  }
  const requested: Record<string, string> = Object.create(null);
  for (const { toolkit, runtimeKind } of options.requirements) {
    if (runtimeKind === undefined) continue;
    if (typeof runtimeKind !== 'string' || !runtimeKind.trim() || runtimeKind !== runtimeKind.trim()) {
      throw new Error(`Toolkit "${toolkit.name}" must declare a non-empty Runtime kind.`);
    }
    if (!Object.hasOwn(factories, runtimeKind)) throw new Error(`No Runtime client adapter registered for ${runtimeKind}.`);
    requested[toolkit.name] = runtimeKind;
  }
  if (!Object.keys(requested).length) return { bindings: {}, close: async () => {} };
  let connection = await ensureRuntimeService({ directory: options.directory, requirements: requested });
  let reconnecting: Promise<RuntimeClient> | undefined;
  let closed = false;
  const currentConnection = async (): Promise<RuntimeClient> => {
    if (closed) throw new RuntimeServiceError('connection_lost', 'Host Runtime connection is closed.');
    if (connection.isConnected) return connection;
    reconnecting ??= ensureRuntimeService({ directory: options.directory, requirements: requested })
      .then(async (next) => {
        if (closed) {
          await next.close();
          throw new RuntimeServiceError('connection_lost', 'Host Runtime connection is closed.');
        }
        connection = next;
        return next;
      }).finally(() => { reconnecting = undefined; });
    return reconnecting;
  };
  const caller: RuntimeCaller = {
    // Never replay a call that may have reached the old service. Only a later
    // invocation can establish a new client identity after disconnection.
    call: async (toolkitName, method, args, execution, signal) => {
      if (signal?.aborted) throw new RuntimeServiceError('aborted', 'Runtime operation cancelled before execution.');
      return (await currentConnection()).call(toolkitName, method, args, execution, signal);
    },
  };
  try {
    const bindings: Record<string, ConnectedToolkitRuntime> = Object.create(null);
    for (const [toolkitName, binding] of Object.entries(connection.bindings)) {
      bindings[toolkitName] = {
        runtimeKind: binding.runtimeKind,
        client: factories[binding.runtimeKind](caller, toolkitName),
      };
    }
    return { bindings, close: async () => {
      closed = true;
      await reconnecting?.catch(() => {});
      await connection.close();
    } };
  } catch (error) {
    await connection.close();
    throw error;
  }
}
