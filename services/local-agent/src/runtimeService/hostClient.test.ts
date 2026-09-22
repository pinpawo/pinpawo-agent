import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { isCommand } from '@langchain/langgraph';
import { ToolkitRuntimeManager, type AgentToolkit } from '@pinpawo/pet-agent';
import { createBrowserToolkit } from '@pinpawo-toolkit/browser';
import { loadPluginsFromDir } from '../pluginLoader';
import { createBashToolkit } from '../toolkits/local';
import { runShellTool } from '../toolkits/local/shellTools';
import { connectHostRuntimes } from './hostClient';
import { connectRuntimeService } from './launcher';
import { runtimeServicePaths } from './config';
import type { RuntimeExecution, RuntimeServiceConfig } from './types';

type HostConnection = Awaited<ReturnType<typeof connectHostRuntimes>>;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function closeHttpFixtures(servers: readonly Server[]): Promise<void> {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
}

function assertBrowserSuccess(value: { ok?: boolean; error?: { code?: string; message?: string } }, operation: string): void {
  if (value.ok !== false) return;
  const failure = JSON.stringify({ code: value.error?.code, message: value.error?.message }).slice(0, 4096);
  // Emit the original structured failure before cleanup can produce a second
  // error. Do not print service config, credentials or environment values.
  process.stderr.write('[host-cdp] ' + operation + ': ' + failure + '\n');
  assert.fail(operation + ': ' + failure);
}

async function eventually(check: () => Promise<boolean>, message: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(25);
  }
  assert.fail(message);
}

function scope(workdir: string): RuntimeExecution {
  return { threadId: 'same-thread', taskId: 'same-task', runId: 'same-run', delegationId: 'same-delegation', workdir };
}

function invocation(host: HostConnection, toolkits: readonly AgentToolkit[], toolkitName: string, execution: RuntimeExecution) {
  const selection = new ToolkitRuntimeManager(host.bindings).select(toolkits);
  return { context: { toolkitName, executionScope: execution, toolkitRuntimes: selection.runtimes } };
}

async function serviceFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'ppr-adapter-'));
  const paths = runtimeServicePaths(directory);
  const hosts: HostConnection[] = [];
  t.after(async () => {
    await Promise.all(hosts.map((host) => host.close()));
    const admin = await connectRuntimeService({ directory, administrative: true }).catch((error: unknown) => {
      const code = (error as { code?: string }).code;
      if (code === 'ENOENT' || code === 'ECONNREFUSED') return undefined;
      throw error;
    });
    if (admin) {
      try { await admin.stopService(); } finally { await admin.close(); }
    }
    await eventually(async () => {
      try { await stat(paths.lock); return false; } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
        throw error;
      }
    }, 'The isolated Runtime service did not release its lock; preserving its directory.');
    if (process.platform !== 'win32') await rm(dirname(paths.endpoint), { recursive: true, force: true });
    // Windows holds the service's cwd until process exit, just after lock release.
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return {
    directory,
    async configure(config: RuntimeServiceConfig) { await writeFile(paths.config, JSON.stringify(config)); },
    async connect(options: Omit<Parameters<typeof connectHostRuntimes>[0], 'directory'>) {
      const host = await connectHostRuntimes({ ...options, directory });
      hosts.push(host);
      return host;
    },
  };
}

test('static Shell Tools and a loaded extension client adapter invoke the independent Runtime service', { timeout: 45_000 }, async (t) => {
  const fixture = await serviceFixture(t);
  const plugins = join(fixture.directory, 'plugins');
  await mkdir(plugins);
  const modulePath = join(plugins, 'example.mjs');
  await writeFile(modulePath, `
import { tool } from ${JSON.stringify(import.meta.resolve('@langchain/core/tools'))};
import { z } from ${JSON.stringify(import.meta.resolve('zod'))};
import { defineToolkit } from ${JSON.stringify(import.meta.resolve('@pinpawo/pet-agent'))};
export default { name: 'runtime-adapter-test' };
export const runtimeClients = {
  example: (caller, toolkitName) => ({
    echo: (value, execution, signal) => caller.call(toolkitName, 'echo', { value }, execution, signal),
  }),
};
const echo = tool(async ({ value }, runtime) => {
  const { executionScope, toolkitRuntimes } = runtime.context;
  return JSON.stringify(await toolkitRuntimes.example.echo(value, executionScope, runtime.signal));
}, { name: 'extension_echo', description: 'Read the service identity and echo a test value.', schema: z.object({ value: z.string() }) });
export const toolkits = [defineToolkit({ name: 'example', description: 'Exercise a plugin Runtime client adapter.', runtime: 'example', tools: [{ tool: echo }] })];
export const runtimeFactories = {
  example: () => ({
    async call(method, args, context) {
      if (method !== 'echo') throw new Error('Unknown operation');
      return { pid: process.pid, clientId: context.clientId, toolkitName: context.toolkitName, execution: context.execution, value: args.value };
    },
    async releaseClient() {}, async close() {}, diagnose() { return { ready: true }; },
  }),
};
`);
  await fixture.configure({
    instances: { local: { type: 'shell', env: { PINPAWO_ADAPTER_TEST: 'from-runtime' }, pathBase: fixture.directory }, extension: { type: 'example' } },
    toolkitBindings: { bash: 'local', example: 'extension' },
    modules: [modulePath],
  });
  const loaded = await loadPluginsFromDir(plugins);
  assert.equal(loaded.plugins.length, 1);
  assert.equal(typeof loaded.runtimeClients.example, 'function');
  const extension = loaded.toolkitSources[0]!.definitions[0]!;
  const shell = createBashToolkit([runShellTool]);
  const toolkits = [shell, extension];
  const a = await fixture.connect({ toolkits, clientFactories: loaded.runtimeClients });
  const b = await fixture.connect({ toolkits, clientFactories: loaded.runtimeClients });
  const execution = scope(fixture.directory);
  const command = process.platform === 'win32'
    ? '[Console]::Write($env:PINPAWO_ADAPTER_TEST)'
    : 'printf "%s" "$PINPAWO_ADAPTER_TEST"';
  const shellOutput = await runShellTool.invoke({ command, cwd: fixture.directory }, invocation(a, toolkits, 'bash', execution));
  assert.match(String(shellOutput), /from-runtime/);
  const echo = extension.tools[0]!.tool;
  const first = JSON.parse(await echo.invoke({ value: 'first' }, invocation(a, toolkits, 'example', execution)) as string);
  const second = JSON.parse(await echo.invoke({ value: 'second' }, invocation(b, toolkits, 'example', execution)) as string);
  assert.notEqual(first.pid, process.pid);
  assert.equal(first.pid, second.pid);
  assert.equal(first.clientId, a.bindings.example!.identity.clientId);
  assert.equal(second.clientId, b.bindings.example!.identity.clientId);
  assert.notEqual(first.clientId, second.clientId);
  assert.equal(first.toolkitName, 'example');
  assert.deepEqual(first.execution, execution);
  assert.equal(first.value, 'first');
  await a.close();
  const afterDisconnect = JSON.parse(await echo.invoke({ value: 'still-connected' }, invocation(b, toolkits, 'example', execution)) as string);
  assert.equal(afterDisconnect.pid, second.pid);
  assert.equal(afterDisconnect.value, 'still-connected');
});
test('real CDP Static Browser Tools cross Host adapters and IPC with client isolation and artifact cleanup', {
  skip: process.env.PINPAWO_TEST_CDP !== '1', timeout: 60_000,
}, async (t) => {
  let otherOrigin = '';
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (request.url === '/b') { response.end('<title>Host B</title><h1>Only Host B</h1>'); return; }
    response.end('<title>Host A</title><h1>Only Host A</h1><button id="cross" onclick="window.open(\'' + otherOrigin + '/private\')">Cross origin</button>');
  });
  const other = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end('<title>Forbidden</title><h1>Unapproved private content</h1>');
  });
  // Register HTTP cleanup before the Runtime fixture: a rejected service
  // cleanup hook must never leave these listening handles alive.
  t.after(() => closeHttpFixtures([server, other]));
  const fixture = await serviceFixture(t);
  await Promise.all([
    new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)),
    new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve)),
  ]);
  const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  otherOrigin = 'http://127.0.0.1:' + (other.address() as { port: number }).port;
  await fixture.configure({
    instances: { browser: { type: 'cdp', headless: true } },
    toolkitBindings: { browser: 'browser' },
  });
  const browser = createBrowserToolkit();
  const toolkits = [browser];
  const a = await fixture.connect({ toolkits });
  const b = await fixture.connect({ toolkits });
  const execution = scope(fixture.directory);
  const invoke = async (host: HostConnection, name: string, input: Record<string, unknown> = {}, expectedError = false) => {
    const tool = browser.tools.find((definition) => definition.tool.name === name)!.tool;
    const output = await tool.invoke(input, invocation(host, toolkits, 'browser', execution));
    if (!expectedError && typeof output === 'string') assertBrowserSuccess(JSON.parse(output), name);
    return output;
  };
  assert.notEqual(a.bindings.browser!.identity.clientId, b.bindings.browser!.identity.clientId);
  assert.equal(a.bindings.browser!.identity.instanceId, b.bindings.browser!.identity.instanceId);
  const openedA = JSON.parse(await invoke(a, 'browser_open', { url: origin }) as string);
  const openedB = JSON.parse(await invoke(b, 'browser_open', { url: origin + '/b' }) as string);
  assert.equal(openedA.title, 'Host A');
  assert.equal(openedB.title, 'Host B');
  const diagnosticA = await a.bindings.browser!.diagnose!() as { pid: number };
  const diagnosticB = await b.bindings.browser!.diagnose!() as { pid: number };
  assert.notEqual(diagnosticA.pid, process.pid);
  assert.equal(diagnosticA.pid, diagnosticB.pid);
  assert.equal(JSON.parse(await invoke(a, 'browser_snapshot') as string).title, 'Host A');
  assert.equal(JSON.parse(await invoke(b, 'browser_snapshot') as string).title, 'Host B');

  const screenshot = await invoke(a, 'browser_screenshot');
  assert.ok(isCommand(screenshot));
  const messages = (screenshot.update as { messages: Array<{ content: unknown; contentBlocks: Array<{ type: string }> }> }).messages;
  assert.ok(messages[1]!.contentBlocks.some((block) => block.type === 'image'));
  const serialized = String(messages[0]!.content);
  const artifact = JSON.parse(serialized.slice(serialized.indexOf('{'))) as { path: string; byteLength: number };
  assert.equal((await stat(artifact.path)).size, artifact.byteLength);
  assert.ok((await readFile(artifact.path)).length > 0);

  const crossOrigin = JSON.parse(await invoke(a, 'browser_click', { selector: '#cross' }, true) as string);
  assert.equal(crossOrigin.ok, false);
  assert.equal(crossOrigin.error.code, 'origin_changed');
  assert.equal(crossOrigin.error.retryable, false);
  assert.equal(crossOrigin.error.details.interactionDispatched, true);
  assert.equal(crossOrigin.error.details.manualActionRequired, true);
  assert.equal(String(await invoke(a, 'browser_extract', {}, true)).includes('Unapproved private content'), false);

  await a.close();
  await eventually(async () => {
    try { await stat(artifact.path); return false; } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw error;
    }
  }, 'Disconnecting Host A did not remove its screenshot.');
  assert.equal(JSON.parse(await invoke(b, 'browser_snapshot') as string).title, 'Host B');
  const disconnected = JSON.parse(await invoke(a, 'browser_snapshot', {}, true) as string);
  assert.equal(disconnected.ok, false);
  assert.equal(disconnected.error.code, 'connection_lost');
  const replacement = await fixture.connect({ toolkits });
  const staleSession = JSON.parse(await invoke(replacement, 'browser_snapshot', {}, true) as string);
  assert.equal(staleSession.error.code, 'browser_not_open');
});
