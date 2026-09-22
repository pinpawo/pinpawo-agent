import type { HostToolkitRegistration, ToolkitRuntimeClientBinding } from '../toolkits/runtimeBinding';
import { BROWSER_RUNTIME_METHODS, type BrowserRuntimeCallContext, type BrowserRuntimePort } from '@pinpawo-toolkit/browser';
import { createShellRuntimeClient } from '../toolkits/local/shellClient';
import { ensureRuntimeService } from './launcher';
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
  registrations: readonly HostToolkitRegistration[];
  directory?: string;
  clientFactories?: Readonly<Record<string, RuntimeClientFactory>>;
}) {
  const factories: Record<string, RuntimeClientFactory> = Object.assign(Object.create(null), {
    shell: createShellRuntimeClient,
    cdp: createBrowserClient,
  });
  for (const [type, factory] of Object.entries(options.clientFactories ?? {})) {
    if (Object.hasOwn(factories, type)) throw new Error(`Duplicate Runtime client factory: ${type}`);
    factories[type] = factory;
  }
  const requested: Record<string, string> = Object.create(null);
  for (const { toolkit, runtimeKind } of options.registrations) {
    if (runtimeKind === undefined) continue;
    if (typeof runtimeKind !== 'string' || !runtimeKind.trim() || runtimeKind !== runtimeKind.trim()) {
      throw new Error(`Toolkit "${toolkit.name}" must declare a non-empty Runtime kind.`);
    }
    if (!Object.hasOwn(factories, runtimeKind)) throw new Error(`No Runtime client adapter registered for ${runtimeKind}.`);
    requested[toolkit.name] = runtimeKind;
  }
  if (!Object.keys(requested).length) return { bindings: {}, close: async () => {} };
  const connection = await ensureRuntimeService({ directory: options.directory, toolkits: requested });
  try {
    const bindings: Record<string, ToolkitRuntimeClientBinding> = Object.create(null);
    for (const [toolkitName, binding] of Object.entries(connection.bindings)) {
      bindings[toolkitName] = {
        runtimeKind: binding.runtimeType,
        client: factories[binding.runtimeType](connection, toolkitName),
      };
    }
    return { bindings, close: () => connection.close() };
  } catch (error) {
    await connection.close();
    throw error;
  }
}
