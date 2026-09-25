import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type BrowserBridgeStatus,
  type BrowserExtensionBridge,
} from './drivers/chromeExtension/bridge';
import { ChromeExtensionBrowserRS } from './chromeExtensionBrowserRS';
import type { BrowserRSCallContext } from './browserRS';

function call(
  agentSessionId: string,
  workdir = process.cwd(),
): BrowserRSCallContext {
  return {
    agentSessionId,
    workdir,
  };
}

/** Fake bridges accept the start the RS makes before its first call. */
const lease = {
  async start() {},
  async stop() {},
};

test('the BrowserRS owns its bridge: start listens, dispose stops it', async () => {
  const lifecycle: string[] = [];
  const bridge = {
    async start() { lifecycle.push('start'); },
    async stop() { lifecycle.push('stop'); },
  } as unknown as BrowserExtensionBridge;
  const runtime = new ChromeExtensionBrowserRS({ bridge });

  await Promise.all([runtime.start(), runtime.start()]);
  assert.deepEqual(lifecycle, ['start']);
  await runtime.dispose();
  assert.deepEqual(lifecycle, ['start', 'stop']);
});

test('one Agent session keeps its Browser session when the call workdir changes', async (t) => {
  const contexts: unknown[] = [];
  const bridge = {
    ...lease,
    async sendCommand(command: string, params: Record<string, unknown>) {
      contexts.push(params.browserContextId);
      if (command === 'navigate') return { ok: true };
      return {
        title: 'Example',
        url: String(params.url ?? 'https://example.com/page'),
        text: 'Readable page',
        interactive: [],
        interactiveCount: 0,
      };
    },
    getStatus() {
      return {
        listening: true,
        hostConnected: true,
        extensionConnected: true,
        debuggerAttached: true,
        targetAlive: true,
        connectionId: 'connection-1',
        extensionId: 'extension-1',
        activeTabId: 1,
        activeTabBinding: 'agent',
        userBoundOrigin: null,
        stateRevision: 1,
        capabilities: ['navigate'],
        socketPath: '/tmp/browser.sock',
      } satisfies BrowserBridgeStatus;
    },
  } as unknown as BrowserExtensionBridge;
  const runtime = new ChromeExtensionBrowserRS({ bridge });
  t.after(async () => await runtime.dispose());

  await runtime.open(call('thread-a', '/workspace/a'), 'https://example.com/a');
  await runtime.snapshot(call('thread-a', '/workspace/other'));
  const sessionA = new Set(contexts.splice(0));
  await runtime.open(call('thread-b', '/workspace/b'), 'https://example.com/b');
  const sessionB = new Set(contexts.splice(0));

  // Workdir is a per-call condition, not part of the session: thread-a kept
  // one browser context across the workdir change; thread-b has its own.
  assert.equal(sessionA.size, 1);
  assert.equal(sessionB.size, 1);
  assert.notDeepEqual([...sessionA], [...sessionB]);
});

test('BrowserRS refuses to create a session without an Agent session id', async (t) => {
  const runtime = new ChromeExtensionBrowserRS({ bridge: lease as unknown as BrowserExtensionBridge });
  t.after(async () => await runtime.dispose());

  await assert.rejects(
    runtime.open(call(''), 'https://example.com'),
    /requires an Agent session id/,
  );
});

test('BrowserRS ensureSession is idempotent and never closed by use', async (t) => {
  const runtime = new ChromeExtensionBrowserRS({ bridge: lease as unknown as BrowserExtensionBridge });
  t.after(async () => await runtime.dispose());
  runtime.ensureSession('thread-1');
  runtime.ensureSession('thread-1');
  assert.deepEqual(runtime.status(), { available: true });
});

test('BrowserRS routes separate Agent sessions with distinct opaque extension context ids', async (t) => {
  const calls: Array<{ command: string; params: Record<string, unknown> }> = [];
  const status: BrowserBridgeStatus = {
    listening: true,
    hostConnected: true,
    extensionConnected: true,
    debuggerAttached: true,
    targetAlive: true,
    connectionId: 'connection-1',
    extensionId: 'extension-1',
    activeTabId: 1,
    activeTabBinding: 'agent',
    userBoundOrigin: null,
    stateRevision: 1,
    capabilities: ['navigate'],
    socketPath: '/tmp/browser.sock',
  };
  const bridge = {
    ...lease,
    async sendCommand(command: string, params: Record<string, unknown>) {
      calls.push({ command, params });
      if (command === 'navigate') {
        return { ok: true };
      }
      return {
        title: 'Example',
        url: String(params.url ?? 'https://example.com/page'),
        text: 'Readable page',
        interactive: [],
        interactiveCount: 0,
      };
    },
    getStatus() {
      return status;
    },
  } as unknown as BrowserExtensionBridge;
  const runtime = new ChromeExtensionBrowserRS({ bridge });
  t.after(async () => await runtime.dispose());

  await runtime.open(call('thread-1'), 'https://example.com/first');
  await runtime.open(call('thread-2'), 'https://example.com/second');

  const navigations = calls.filter((call) => call.command === 'navigate');
  const firstContextId = navigations[0]?.params.browserContextId;
  const secondContextId = navigations[1]?.params.browserContextId;
  assert.equal(navigations.length, 2);
  assert.equal(typeof firstContextId, 'string');
  assert.equal(typeof secondContextId, 'string');
  assert.notEqual(firstContextId, secondContextId);
  assert.notEqual(firstContextId, 'thread-1');
  assert.notEqual(secondContextId, 'thread-2');
});

test('BrowserRS broadcasts an unscoped reconnect to every session', async (t) => {
  const generationListeners = new Set<(change: {
    connectionGeneration: number;
    targetGeneration: number;
    contextId?: string;
  }) => void>();
  const status: BrowserBridgeStatus = {
    listening: true,
    hostConnected: true,
    extensionConnected: true,
    debuggerAttached: true,
    targetAlive: true,
    connectionId: 'connection-1',
    extensionId: 'extension-1',
    activeTabId: 1,
    activeTabBinding: 'agent',
    userBoundOrigin: null,
    stateRevision: 1,
    capabilities: ['navigate'],
    socketPath: '/tmp/browser.sock',
    connectionGeneration: 1,
    targetGeneration: 1,
  };
  const bridge = {
    ...lease,
    beginNavigation() {
      return 1;
    },
    async sendCommand(command: string) {
      for (const listener of generationListeners) {
        listener({ connectionGeneration: 2, targetGeneration: 1 });
      }
      if (command === 'navigate') return { ok: true };
      return {
        title: 'Example',
        url: 'https://example.com/page',
        text: 'Readable page',
        interactive: [],
        interactiveCount: 0,
      };
    },
    getStatus() {
      return status;
    },
    onRuntimeEvent() {
      return () => {};
    },
    onGenerationChanged(listener: (change: {
      connectionGeneration: number;
      targetGeneration: number;
      contextId?: string;
    }) => void) {
      generationListeners.add(listener);
      return () => generationListeners.delete(listener);
    },
  } as unknown as BrowserExtensionBridge;
  const runtime = new ChromeExtensionBrowserRS({ bridge });
  t.after(async () => await runtime.dispose());

  await assert.rejects(
    runtime.open(call('thread-1'), 'https://example.com/page'),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'runtime_disconnected');
      return true;
    },
  );
});
