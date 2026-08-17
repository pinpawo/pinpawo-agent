import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { isCommand } from '@langchain/langgraph';
import { persistBrowserScreenshot } from './screenshot';
import { BROWSER_TOOLKIT_NAME } from './constants';
import { createBrowserTools } from './tools';
import type {
  BrowserRuntimeCallContext,
  BrowserRuntimePort,
} from './runtimePort';

function runtimePort(
  value: string,
  onCall?: (context: BrowserRuntimeCallContext) => void,
): BrowserRuntimePort {
  const result = async (context: BrowserRuntimeCallContext) => {
    onCall?.(context);
    return value;
  };
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
    listSessions: async (context) => {
      onCall?.(context);
      return [];
    },
  };
}

function invocation(
  browser: BrowserRuntimePort,
  threadId: string,
  workdir = process.cwd(),
) {
  return {
    context: {
      executionScope: {
        threadId,
        runId: 'run-1',
        delegationId: 'delegation-1',
        workdir,
      },
      toolkitRuntimes: {
        [BROWSER_TOOLKIT_NAME]: browser,
      },
    },
  };
}

test('static Browser tools pass thread identity to the active Runtime on every call', async () => {
  const seen: BrowserRuntimeCallContext[] = [];
  const tools = createBrowserTools();
  const snapshot = tools.find(({ name }) => name === 'browser_snapshot');
  assert.ok(snapshot);

  assert.equal(
    await snapshot.invoke({}, invocation(runtimePort('first', (context) => seen.push(context)), 'thread-1')),
    'first',
  );
  assert.equal(
    await snapshot.invoke({}, invocation(runtimePort('second', (context) => seen.push(context)), 'thread-2')),
    'second',
  );
  assert.deepEqual(
    seen.map(({ threadId }) => threadId),
    ['thread-1', 'thread-2'],
  );
});

test('browser screenshot uses Runtime output and invocation workdir', async () => {
  const workdir = await mkdtemp(resolve(tmpdir(), 'pinpawo-browser-tool-'));
  const browser = runtimePort('unused');
  browser.screenshot = async () => persistBrowserScreenshot({
    mimeType: 'image/png',
    data: Buffer.from('screenshot').toString('base64'),
  }, workdir);
  const screenshotTool = createBrowserTools()
    .find((toolItem) => toolItem.name === 'browser_screenshot');

  assert.ok(screenshotTool);

  const result = await screenshotTool.invoke(
    {},
    invocation(browser, 'thread-1', workdir),
  );

  assert.ok(isCommand(result));
  const messages = (result.update as {
    messages: { _getType(): string; contentBlocks: { type: string }[] }[];
  }).messages;
  assert.deepEqual(messages.map((message) => message._getType()), ['tool', 'human']);
  assert.ok(messages[1]?.contentBlocks.some((block) => block.type === 'image'));
});
