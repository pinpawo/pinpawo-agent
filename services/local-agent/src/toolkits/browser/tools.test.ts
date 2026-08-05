import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { isCommand } from '@langchain/langgraph';
import { getLocalToolsWorkdir, setLocalToolsWorkdir } from '../local/pathUtils';
import { persistBrowserScreenshot } from './screenshot';
import { createBrowserTools, type BrowserToolkitSession } from './tools';

function session(value: string): BrowserToolkitSession {
  const result = async () => value;
  return {
    open: result,
    openWithProfile: result,
    snapshot: result,
    click: result,
    type: result,
    scroll: result,
    wait: result,
    extract: result,
    screenshot: result,
    close: result,
    listSessions: async () => [],
  };
}

test('Browser tools execute through their resolved runtime binding', async () => {
  const first = createBrowserTools(session('first'));
  const second = createBrowserTools(session('second'));
  const firstSnapshot = first.find(({ name }) => name === 'browser_snapshot');
  const secondSnapshot = second.find(({ name }) => name === 'browser_snapshot');

  assert.ok(firstSnapshot);
  assert.ok(secondSnapshot);
  assert.equal(await firstSnapshot.invoke({}), 'first');
  assert.equal(await secondSnapshot.invoke({}), 'second');
  assert.notEqual(firstSnapshot, secondSnapshot);
});

test('bound browser screenshot writes its own tool result and image message', async (t) => {
  const boundSession = session('image');
  const screenshotTool = createBrowserTools(boundSession).find((toolItem) =>
    toolItem.name === 'browser_screenshot');

  assert.ok(screenshotTool);

  const previousWorkdir = getLocalToolsWorkdir();
  const workdir = await mkdtemp(resolve(tmpdir(), 'pinpawo-browser-tool-'));
  setLocalToolsWorkdir(workdir);
  boundSession.screenshot = async () => persistBrowserScreenshot({
    mimeType: 'image/png',
    data: Buffer.from('screenshot').toString('base64'),
  });
  t.after(() => {
    setLocalToolsWorkdir(previousWorkdir);
  });

  const result = await screenshotTool.invoke({}, {
    context: {
      executionScope: {
        threadId: 'thread-1',
        runId: 'run-1',
        delegationId: 'delegation-1',
      },
    },
  });

  assert.ok(isCommand(result));
  const messages = (result.update as { messages: { _getType(): string }[] }).messages;
  assert.deepEqual(messages.map((message) => message._getType()), ['tool', 'human']);
  assert.match(JSON.stringify(messages[1]), /data:image\/png;base64,/);
});
