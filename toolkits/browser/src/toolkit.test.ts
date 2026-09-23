import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolkitRuntimeManager } from '@pinpawo/pet-agent';
import { createBrowserToolkit } from './toolkit';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserRuntime } from './runtime';
import { BrowserExtensionBridge } from './drivers/chromeExtension/bridge';

/** Keep tests off the user's real bridge socket. */
function isolatedToolkit() {
  const dir = mkdtempSync(join(tmpdir(), 'ppb-'));
  return createBrowserToolkit({
    bridge: new BrowserExtensionBridge({
      socketPath: join(dir, 'bridge.sock'),
      tokenPath: join(dir, 'bridge.token'),
    }),
  });
}

test('only browser_screenshot requires image input', () => {
  const toolkit = createBrowserToolkit();
  const requiringImage = toolkit.tools
    .filter((definition) => definition.requiresInputModalities?.includes('image'))
    .map((definition) => definition.tool.name);

  assert.deepEqual(requiringImage, ['browser_screenshot']);
  assert.equal(toolkit.runtime?.resolve, undefined);
  assert.equal(toolkit.runtime?.bindTools, undefined);
  assert.equal(toolkit.runtime?.release, undefined);
});

test('Browser Runtime is exposed as a port without replacing static tools', async () => {
  const toolkit = isolatedToolkit();
  const manager = new ToolkitRuntimeManager();
  const staticTools = toolkit.tools.map(({ tool }) => tool);
  const execution = await manager.resolve({
    toolkits: [toolkit],
    execution: {
      threadId: 'thread-1',
      taskId: 'task-1',
      runId: 'run-1',
      delegationId: 'delegation-1',
      workdir: process.cwd(),
    },
  });

  assert.deepEqual(
    execution.toolkits[0]?.tools.map(({ tool }) => tool),
    staticTools,
  );
  assert.ok(execution.runtimes.browser instanceof BrowserRuntime);

  await execution.release();
  await manager.stop();
});

test('the extension-only Browser Toolkit has no backend availability gate', () => {
  assert.equal(createBrowserToolkit().availability, undefined);
});

test('separate Host managers start independent Browser Runtime roots', async () => {
  const toolkit = isolatedToolkit();
  const managerA = new ToolkitRuntimeManager();
  const managerB = new ToolkitRuntimeManager();

  const executionA = await managerA.resolve({
    toolkits: [toolkit],
    execution: {
      threadId: 'thread-a',
      taskId: 'task-a',
      runId: 'run-a',
      delegationId: 'delegation-a',
      workdir: process.cwd(),
    },
  });
  const executionB = await managerB.resolve({
    toolkits: [toolkit],
    execution: {
      threadId: 'thread-b',
      taskId: 'task-b',
      runId: 'run-b',
      delegationId: 'delegation-b',
      workdir: process.cwd(),
    },
  });
  const runtimeA = executionA.runtimes.browser;
  const runtimeB = executionB.runtimes.browser;

  assert.notEqual(runtimeA, runtimeB);
  assert.equal((await managerA.diagnose())[0]?.lifecycle, 'ready');
  assert.equal((await managerB.diagnose())[0]?.lifecycle, 'ready');
  await executionA.release();
  await managerA.stop();
  assert.equal((await managerA.diagnose())[0]?.lifecycle, 'stopped');
  assert.equal((await managerB.diagnose())[0]?.lifecycle, 'ready');
  await executionB.release();
  await managerB.stop();
});
