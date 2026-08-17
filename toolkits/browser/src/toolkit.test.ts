import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolkitRuntimeManager } from '@pinpawo/pet-agent';
import { createBrowserToolkit } from './toolkit';
import { BrowserRuntime } from './runtime';

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
  const toolkit = createBrowserToolkit({ backend: () => 'playwright' });
  const manager = new ToolkitRuntimeManager();
  const staticTools = toolkit.tools.map(({ tool }) => tool);
  const execution = await manager.resolve({
    toolkits: [toolkit],
    execution: {
      threadId: 'thread-1',
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

test('browser availability describes structural backend support, not Host selection', async () => {
  let backendReads = 0;
  const toolkit = createBrowserToolkit({
    backend: () => {
      backendReads += 1;
      return 'extension';
    },
  });

  const availability = await toolkit.availability?.();

  assert.deepEqual(availability, { available: true });
  assert.equal(backendReads, 1);
});

test('separate Host managers start independent Browser Runtime roots', async () => {
  const toolkit = createBrowserToolkit({ backend: () => 'playwright' });
  const managerA = new ToolkitRuntimeManager();
  const managerB = new ToolkitRuntimeManager();

  const executionA = await managerA.resolve({
    toolkits: [toolkit],
    execution: {
      threadId: 'thread-a',
      runId: 'run-a',
      delegationId: 'delegation-a',
      workdir: process.cwd(),
    },
  });
  const executionB = await managerB.resolve({
    toolkits: [toolkit],
    execution: {
      threadId: 'thread-b',
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
