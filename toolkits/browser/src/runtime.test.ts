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
): ToolkitRuntimeExecutionScope {
  return {
    threadId,
    runId,
    delegationId,
    workdir: null,
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
    onRuntimeEvent() {
      return () => {};
    },
    onGenerationChanged() {
      return () => {};
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

  const firstContextId = calls[0]?.params.browserContextId;
  const secondContextId = calls[1]?.params.browserContextId;
  assert.equal(calls[0]?.command, 'navigate');
  assert.equal(calls[1]?.command, 'navigate');
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
    async sendCommand() {
      for (const listener of generationListeners) {
        listener({ connectionGeneration: 2, targetGeneration: 1 });
      }
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
