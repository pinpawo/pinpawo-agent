import assert from 'node:assert/strict';
import test from 'node:test';
import { createProcessTools } from './processTools';
import { runShellTool } from './shellTools';
import { createLocalRuntimeFixture, testExecution } from './shellTestSupport';

const [waitTool, terminateTool, listTool] = createProcessTools();
const posix = process.platform !== 'win32';
const processIdFrom = (output: unknown) => {
  const match = /Process id: (\S+)/.exec(String(output));
  assert.ok(match, `expected a process id in: ${String(output)}`);
  return match[1]!;
};

test('static tools yield, wait for new output and retain exit status', { skip: !posix }, async (t) => {
  const fixture = createLocalRuntimeFixture();
  t.after(() => fixture.close());
  const started = await fixture.invoke(runShellTool, {
    command: 'printf first; sleep 1.3; printf second; exit 4', timeoutSeconds: 1,
  });
  assert.match(String(started), /first/);
  const processId = processIdFrom(started);
  const result = String(await fixture.invoke(waitTool!, { processId, waitSeconds: 5 }));
  assert.match(result, /exited with code 4/);
  assert.match(result, /second/);
  assert.doesNotMatch(result, /first/);
  assert.match(String(await fixture.invoke(waitTool!, { processId })), /no new output/);
});

test('static tools list and terminate only this execution\'s processes', { skip: !posix }, async (t) => {
  const fixture = createLocalRuntimeFixture();
  t.after(() => fixture.close());
  assert.equal(await fixture.invoke(listTool!, {}), 'No background processes.');
  const processId = processIdFrom(await fixture.invoke(runShellTool, { command: 'sleep 20', timeoutSeconds: 1 }));
  assert.match(String(await fixture.invoke(listTool!, {})), /still running/);
  assert.match(String(await fixture.invoke(waitTool!, { processId }, undefined, testExecution({ runId: 'another' }))), /different execution/);
  assert.match(String(await fixture.invoke(terminateTool!, { processId })), /terminated/);
  assert.match(String(await fixture.invoke(waitTool!, { processId: 'missing' })), /No such process/);
});

test('static shell and process tools have no local execution fallback', async () => {
  await assert.rejects(runShellTool.invoke({ command: 'printf forbidden', cwd: process.cwd() }), /connected Shell Runtime/);
  assert.match(String(await waitTool!.invoke({ processId: 'missing' })), /connected Shell Runtime/);
  await assert.rejects(listTool!.invoke({}), /connected Shell Runtime/);
});
