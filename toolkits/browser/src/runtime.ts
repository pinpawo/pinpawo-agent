import { CdpConnection } from './connection';
import { BrowserOperationError } from './errors';
import { CdpBrowserSession, checkBrowserAbort, type BrowserOpenOptions } from './session';
import type { CdpRuntimeConfig } from './options';
import { BROWSER_RUNTIME_METHODS, type BrowserRuntimePort } from './runtimePort';

export type CdpRuntimeCallContext = {
  clientId: string;
  toolkitName: string;
  execution: { threadId: string; workdir: string; taskId?: string; runId?: string; delegationId?: string };
  signal?: AbortSignal;
};

type ThreadSessions = {
  clientId: string;
  toolkitName: string;
  workdir: string;
  active: string;
  sessions: Map<string, CdpBrowserSession>;
};

export class CdpRuntime {
  private readonly connection: CdpConnection;
  private readonly threads = new Map<string, ThreadSessions>();
  private readonly releasedClients = new Set<string>();
  private closed = false;

  constructor(config: CdpRuntimeConfig = {}) {
    this.connection = new CdpConnection(config);
  }

  async call(method: string, args: unknown[], context: CdpRuntimeCallContext): Promise<unknown> {
    if (!BROWSER_RUNTIME_METHODS.includes(method as keyof BrowserRuntimePort)) throw new Error('Unknown CDP operation: ' + method);
    if (!Array.isArray(args)) throw new Error('CDP operation args must be an array.');
    if (!context.clientId || !context.toolkitName || !context.execution?.threadId || !context.execution.workdir) {
      throw new Error('CDP operation requires client, Toolkit, thread and workdir.');
    }
    if (this.closed || this.releasedClients.has(context.clientId)) {
      throw new BrowserOperationError('runtime_disconnected', 'CDP client has been released.');
    }
    checkBrowserAbort(context.signal);
    const key = JSON.stringify([context.clientId, context.toolkitName, context.execution.threadId]);
    let thread = this.threads.get(key);
    if (thread && thread.workdir !== context.execution.workdir) {
      throw new BrowserOperationError('browser_context_conflict', 'This browser thread is already bound to another workdir.');
    }
    if (method === 'listSessions') return [...(thread?.sessions.keys() ?? [])];
    if (!thread) {
      if (method !== 'open' && method !== 'openWithProfile') {
        throw new BrowserOperationError('browser_not_open', 'Use browser_open first.', true);
      }
      thread = { clientId: context.clientId, toolkitName: context.toolkitName, workdir: context.execution.workdir, active: 'default', sessions: new Map() };
      this.threads.set(key, thread);
    }
    const options = (method === 'open' ? args[1] : method === 'openWithProfile' ? args[2] : undefined) as BrowserOpenOptions | undefined;
    if (method === 'open' || method === 'openWithProfile') {
      if (typeof args[0] !== 'string') throw new Error('Browser URL must be a string.');
      thread.active = options?.session ?? 'default';
    }
    const name = thread.active;
    let session = thread.sessions.get(name);
    if (!session) {
      if (method !== 'open' && method !== 'openWithProfile') throw new BrowserOperationError('browser_not_open', 'Use browser_open first.', true);
      session = new CdpBrowserSession(this.connection, thread.workdir, name);
      thread.sessions.set(name, session);
    }
    if (method === 'close') {
      thread.sessions.delete(name);
      return session.close();
    }
    const selected = session;
    try {
      return await selected.run(async () => {
        switch (method) {
          case 'open': return selected.open(args[0] as string, options);
          case 'openWithProfile':
            if (typeof args[1] !== 'string' || !args[1]) throw new Error('userDataDir must be non-empty.');
            return selected.open(args[0] as string, { ...options, userDataDir: args[1] });
          case 'snapshot': return selected.snapshot();
          case 'click': return selected.click(args[0] as Parameters<CdpBrowserSession['click']>[0]);
          case 'type': return selected.type(args[0] as Parameters<CdpBrowserSession['type']>[0], args[1] as string, args[2] as boolean | undefined);
          case 'scroll': return selected.scroll(args[0] as Parameters<CdpBrowserSession['scroll']>[0]);
          case 'wait': return selected.wait(args[0] as Parameters<CdpBrowserSession['wait']>[0], args[1] as number | undefined, args[2] as Parameters<CdpBrowserSession['wait']>[2]);
          case 'extract': return selected.extract(args[0] as Parameters<CdpBrowserSession['extract']>[0]);
          case 'screenshot': return selected.screenshot();
          default: throw new Error('Unknown CDP operation.');
        }
      }, context.signal);
    } catch (error) {
      if (context.signal?.aborted) thread.sessions.delete(name);
      throw error;
    }
  }

  async releaseClient(clientId: string): Promise<void> {
    this.releasedClients.add(clientId);
    const sessions: CdpBrowserSession[] = [];
    for (const [key, thread] of this.threads) {
      if (thread.clientId !== clientId) continue;
      this.threads.delete(key);
      sessions.push(...thread.sessions.values());
    }
    await Promise.all(sessions.map((session) => session.close()));
  }

  diagnose() {
    return {
      type: 'cdp',
      ...this.connection.diagnose(),
      clients: new Set([...this.threads.values()].map((thread) => thread.clientId)).size,
      sessions: [...this.threads.values()].reduce((count, thread) => count + thread.sessions.size, 0),
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    const clients = new Set([...this.threads.values()].map((thread) => thread.clientId));
    try {
      await Promise.all([...clients].map((client) => this.releaseClient(client)));
    } finally {
      await this.connection.close();
    }
  }
}

export function createCdpRuntime(config: CdpRuntimeConfig = {}): CdpRuntime {
  return new CdpRuntime(config);
}
