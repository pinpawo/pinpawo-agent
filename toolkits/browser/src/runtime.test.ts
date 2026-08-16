import assert from 'node:assert/strict';
import test from 'node:test';
import type { ToolkitRuntimeExecutionScope } from '@pinpawo/pet-agent';
import {
  type BrowserBridgeStatus,
  type BrowserExtensionBridge,
} from './drivers/chromeExtension/bridge';
import { BrowserRuntime } from './runtime';

function execution(
  threadId: string | null,
  runId: string,
  delegationId: string,
  workdir = process.cwd(),
): ToolkitRuntimeExecutionScope {
  return {
    threadId,
    runId,
    delegationId,
    workdir,
  };
}

test('BrowserRuntime keeps one browser workspace per thread, not per delegation', async (t) => {
  const runtime = new BrowserRuntime();
  t.after(async () => await runtime.stop());

  const first = await runtime.resolve(execution('thread-1', 'run-1', 'delegation-1'));
  const later = await runtime.resolve(execution('thread-1', 'run-2', 'delegation-2'));
  const other = await runtime.resolve(execution('thread-2', 'run-3', 'delegation-3'));

  assert.equal(first.owner.threadId, 'thread-1');
  assert.deepEqual(later.owner, { threadId: 'thread-1' });
  assert.equal(first.session, later.session);
  assert.notEqual(first.session, other.session);
});

test('independent BrowserRuntime roots lease one process extension bridge', async () => {
  const lifecycle: string[] = [];
  const bridge = {
    async start() { lifecycle.push('start'); },
    async stop() { lifecycle.push('stop'); },
    getStatus() {
      return {
        listening: lifecycle.includes('start') && !lifecycle.includes('stop'),
        hostConnected: false,
        extensionConnected: false,
        debuggerAttached: false,
        targetAlive: false,
        connectionId: null,
        extensionId: null,
        activeTabId: null,
        activeTabBinding: null,
        userBoundOrigin: null,
        stateRevision: null,
        capabilities: [],
        socketPath: '/tmp/browser.sock',
      } satisfies BrowserBridgeStatus;
    },
  } as unknown as BrowserExtensionBridge;
  const runtimeA = new BrowserRuntime(
    { backend: () => 'extension' },
    { bridge },
  );
  const runtimeB = new BrowserRuntime(
    { backend: () => 'extension' },
    { bridge },
  );

  await Promise.all([runtimeA.start(), runtimeB.start()]);
  assert.deepEqual(lifecycle, ['start']);

  await runtimeA.stop();
  assert.deepEqual(lifecycle, ['start']);

  await runtimeB.stop();
  assert.deepEqual(lifecycle, ['start', 'stop']);
});

test('BrowserRuntime binds each thread to its execution workdir', async (t) => {
  const runtime = new BrowserRuntime();
  t.after(async () => await runtime.stop());

  const first = await runtime.resolve(execution('thread-a', 'run-a', 'delegation-a', '/workspace/a'));
  const second = await runtime.resolve(execution('thread-b', 'run-b', 'delegation-b', '/workspace/b'));

  assert.equal(first.workdir(), '/workspace/a');
  assert.equal(second.workdir(), '/workspace/b');
  await assert.rejects(
    runtime.resolve(execution('thread-a', 'run-c', 'delegation-c', '/workspace/other')),
    /already bound to workdir/,
  );
});

test('BrowserRuntime refuses to create an unowned browser workspace', async (t) => {
  const runtime = new BrowserRuntime();
  t.after(async () => await runtime.stop());

  await assert.rejects(
    runtime.resolve(execution(null, 'run-1', 'delegation-1')),
    /requires a threadId/,
  );
});

test('BrowserRuntime routes separate thread workspaces with distinct opaque extension context ids', async (t) => {
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
  const runtime = new BrowserRuntime(
    { backend: () => 'extension' },
    { bridge },
  );
  t.after(async () => await runtime.stop());

  const first = await runtime.resolve(execution('thread-1', 'run-1', 'delegation-1'));
  const second = await runtime.resolve(execution('thread-2', 'run-2', 'delegation-2'));
  await first.session.open('https://example.com/first', {}, first.owner);
  await second.session.open('https://example.com/second', {}, second.owner);

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

test('BrowserRuntime broadcasts an unscoped reconnect to every thread workspace', async (t) => {
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
  const runtime = new BrowserRuntime({ backend: () => 'extension' }, { bridge });
  t.after(async () => await runtime.stop());

  const binding = await runtime.resolve(execution('thread-1', 'run-1', 'delegation-1'));
  await assert.rejects(
    binding.session.open('https://example.com/page', {}, binding.owner),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'runtime_disconnected');
      return true;
    },
  );
});
