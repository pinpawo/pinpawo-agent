import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  BROWSER_RS_CONTRACT,
  BROWSER_RS_VERSION,
  ChromeExtensionBrowserRS,
  createBrowserToolkit,
  type BrowserExtensionBridge,
} from '@pinpawo-toolkit/browser';
import { RSServiceConnection } from '../rsService/connection';
import type { RSContractClient } from '../rsService/contractClient';
import { ensureToken, resolveRSServicePaths } from '../rsService/paths';
import { startRSService } from '../rsService/server';
import { BrowserRSClient } from './browserRSClient';
import { createBrowserRSServiceHandler } from './browserRSService';

const isWindows = process.platform === 'win32';

type FakeBridge = {
  contexts: unknown[];
  /** Resolves a pending click when the test lets it finish. */
  releaseClick?: () => void;
  clickError?: Error;
};

/**
 * A bridge standing in for the extension: navigation succeeds, snapshots
 * report the last URL of each browser context.
 */
function fakeBridge(state: FakeBridge): BrowserExtensionBridge {
  const urlByContext = new Map<unknown, string>();
  return {
    async start() {},
    async stop() {},
    async sendCommand(command: string, params: Record<string, unknown>) {
      state.contexts.push(params.browserContextId);
      if (command === 'navigate') {
        urlByContext.set(params.browserContextId, String(params.url));
        return { ok: true };
      }
      if (command === 'click') {
        if (state.clickError) throw state.clickError;
        await new Promise<void>((resolvePromise) => { state.releaseClick = resolvePromise; });
      }
      return {
        title: 'Example',
        url: urlByContext.get(params.browserContextId) ?? 'https://example.com/',
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
        capabilities: ['navigate', 'snapshot', 'click'],
        socketPath: '/tmp/browser.sock',
      };
    },
  } as unknown as BrowserExtensionBridge;
}

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'pp-rs-'));
  const paths = resolveRSServicePaths(root);
  const token = await ensureToken(paths);
  const bridge: FakeBridge = { contexts: [] };
  const service = await startRSService({
    endpoint: paths.endpoint,
    token,
    handlers: [createBrowserRSServiceHandler(new ChromeExtensionBrowserRS({ bridge: fakeBridge(bridge) }))],
    log: () => {},
  });
  t.after(async () => {
    bridge.releaseClick?.();
    await service.stop();
    await rm(root, { recursive: true, force: true });
  });
  // A "Host": its own client of the shared service.
  const host = () => {
    const client = new BrowserRSClient({
      connect: async () => await RSServiceConnection.open({
        paths,
        token,
        rs: { contract: BROWSER_RS_CONTRACT, version: BROWSER_RS_VERSION },
      }),
    });
    t.after(async () => await client.dispose());
    return client;
  };
  const admin = async () => {
    const connection = await RSServiceConnection.open({ paths, token });
    t.after(async () => await connection.close());
    return connection;
  };
  return { bridge, host, admin };
}

const call = (agentSessionId: string) => ({ agentSessionId, workdir: process.cwd() });

test('Browser sessions live in the service and outlive the Host', { skip: isWindows }, async (t) => {
  const { bridge, host } = await setup(t);
  const first = host();
  const opened = JSON.parse(await first.open(call('agent-1'), 'https://example.com/a')) as { url: string };
  assert.equal(opened.url, 'https://example.com/a');
  const [contextOfFirstHost] = bridge.contexts.splice(0);
  await first.dispose();

  // A restarted Host with the same Agent session reaches the same page.
  const restarted = host();
  const snapshot = JSON.parse(await restarted.snapshot(call('agent-1'))) as { url: string };
  assert.equal(snapshot.url, 'https://example.com/a');
  assert.deepEqual([...new Set(bridge.contexts.splice(0))], [contextOfFirstHost]);

  // Another Agent session gets a browser context of its own.
  await restarted.open(call('agent-2'), 'https://example.com/b');
  assert.notDeepEqual([...new Set(bridge.contexts.splice(0))], [contextOfFirstHost]);
});

test('Browser errors keep code, retryable and details across the service', { skip: isWindows }, async (t) => {
  const { bridge, host } = await setup(t);
  const browser = host();
  await browser.open(call('agent-1'), 'https://example.com/a');
  bridge.clickError = Object.assign(new Error('Cross-origin popup requires the user.'), {
    code: 'origin_changed',
    retryable: false,
    details: { manualActionRequired: true, interactionDispatched: true },
  });

  // What the Browser tools hand the model: the structured error, intact.
  const [clickTool] = createBrowserToolkit({ browser }).tools
    .map(({ tool }) => tool)
    .filter((candidate) => candidate.name === 'browser_click');
  const result = JSON.parse(String(await clickTool!.invoke(
    { selector: '#popup' },
    { configurable: { thread_id: 'agent-1' }, context: { executionScope: { threadId: 'agent-1', workdir: process.cwd() } } } as never,
  ))) as { ok: boolean; error: Record<string, unknown> };
  assert.equal(result.ok, false);
  assert.deepEqual(result.error, {
    code: 'origin_changed',
    message: 'Cross-origin popup requires the user.',
    retryable: false,
    details: { manualActionRequired: true, interactionDispatched: true },
  });
});

test('a lost connection reports an unknown result for a browser operation', { skip: isWindows }, async (t) => {
  const { host } = await setup(t);
  const browser = host();
  await browser.open(call('agent-1'), 'https://example.com/a');

  const pending = browser.click(call('agent-1'), '#slow');
  setTimeout(() => {
    void (browser as unknown as { transport: RSContractClient }).transport.currentConnection!.close();
  }, 50);
  await assert.rejects(pending, (error: unknown) => {
    const record = error as { code?: string; retryable?: boolean; details?: Record<string, unknown> };
    return record.code === 'result_unknown'
      && record.retryable === false
      && record.details?.resultUnknown === true;
  });
});

test('an unreachable service makes only the Browser Toolkit unavailable', { skip: isWindows }, async () => {
  const browser = new BrowserRSClient({
    connect: async () => { throw Object.assign(new Error('no service'), { code: 'ECONNREFUSED' }); },
  });
  await assert.rejects(browser.start());
  assert.equal((await browser.status()).available, false);
  assert.equal((await createBrowserToolkit({ browser }).availability!()).available, false);
  await assert.rejects(browser.snapshot(call('agent-1')), (error: unknown) => (
    (error as { code?: string; retryable?: boolean }).code === 'runtime_disconnected'
    && (error as { retryable?: boolean }).retryable === true
  ));

  const windows = new BrowserRSClient({ platform: 'win32' });
  await assert.rejects(windows.start(), /Windows/);
});

test('an open page keeps the service busy, and stopping it reports the closed sessions', { skip: isWindows }, async (t) => {
  const { host, admin } = await setup(t);
  const browser = host();
  const channel = await admin();
  assert.equal((await channel.admin('status') as { busy: boolean }).busy, false);

  await browser.open(call('agent-1'), 'https://example.com/a');
  const status = await channel.admin('status') as {
    busy: boolean;
    rs: Array<{ details: Record<string, unknown> }>;
  };
  assert.equal(status.busy, true);
  assert.equal(status.rs[0]!.details.openSessions, 1);

  assert.deepEqual(
    await channel.admin('stop'),
    { rs: [{ contract: BROWSER_RS_CONTRACT, report: { closedSessions: 1 } }] },
  );
});

test('a bridge that could not start recovers when a Host asks again', { skip: isWindows }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pp-rs-'));
  const paths = resolveRSServicePaths(root);
  const token = await ensureToken(paths);
  const bridge = fakeBridge({ contexts: [] });
  let socketTaken = true;
  bridge.start = async () => {
    if (socketTaken) throw new Error('another local-agent browser bridge is already listening');
  };
  const rs = new ChromeExtensionBrowserRS({ bridge });
  await rs.start().catch(() => undefined);
  const service = await startRSService({
    endpoint: paths.endpoint,
    token,
    handlers: [createBrowserRSServiceHandler(rs)],
    log: () => {},
  });
  t.after(async () => {
    await service.stop();
    await rm(root, { recursive: true, force: true });
  });
  const browser = new BrowserRSClient({
    connect: async () => await RSServiceConnection.open({
      paths,
      token,
      rs: { contract: BROWSER_RS_CONTRACT, version: BROWSER_RS_VERSION },
    }),
  });
  t.after(async () => await browser.dispose());

  // Startup fails, so the Host keeps retrying it.
  await assert.rejects(browser.start(), /already listening/);
  // The other process lets go of the socket; the next attempt recovers.
  socketTaken = false;
  await browser.start();
  assert.deepEqual(await browser.status(), { available: true });
});
