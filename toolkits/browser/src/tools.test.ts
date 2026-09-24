import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { isCommand } from '@langchain/langgraph';
import { persistBrowserScreenshot } from './screenshot';
import { createBrowserTools } from './tools';
import {
  BROWSER_RS_CONTRACT,
  BROWSER_RS_VERSION,
  type BrowserRS,
  type BrowserRSCallContext,
} from './browserRS';

function fakeBrowserRS(
  value: string,
  onCall?: (context: BrowserRSCallContext) => void,
): BrowserRS {
  const result = async (context: BrowserRSCallContext) => {
    onCall?.(context);
    return value;
  };
  return {
    contract: BROWSER_RS_CONTRACT,
    version: BROWSER_RS_VERSION,
    status: () => ({ available: true }),
    ensureSession: () => undefined,
    open: result,
    snapshot: result,
    click: result,
    type: result,
    scroll: result,
    wait: result,
    extract: result,
    screenshot: result,
    close: result,
  };
}

function invocation(
  threadId: string,
  workdir = process.cwd(),
) {
  return {
    context: {
      executionScope: {
        threadId,
        taskId: 'task-1',
        runId: 'run-1',
        delegationId: 'delegation-1',
        workdir,
      },
    },
  };
}

test('static Browser tools pass the Agent session to the injected BrowserRS on every call', async () => {
  const seen: BrowserRSCallContext[] = [];
  const tools = createBrowserTools(fakeBrowserRS('page', (context) => seen.push(context)));
  const snapshot = tools.find(({ name }) => name === 'browser_snapshot');
  assert.ok(snapshot);

  assert.equal(await snapshot.invoke({}, invocation('thread-1')), 'page');
  assert.equal(await snapshot.invoke({}, invocation('thread-2')), 'page');
  assert.deepEqual(
    seen.map(({ agentSessionId }) => agentSessionId),
    ['thread-1', 'thread-2'],
  );
});

test('a Browser tool call outside an Agent session is an ordinary tool error', async () => {
  const snapshot = createBrowserTools(fakeBrowserRS('page'))
    .find(({ name }) => name === 'browser_snapshot');
  assert.ok(snapshot);
  assert.match(String(await snapshot.invoke({})), /requires an Agent session/);
});

test('browser screenshot uses BrowserRS output and invocation workdir', async () => {
  const workdir = await mkdtemp(resolve(tmpdir(), 'pinpawo-browser-tool-'));
  const browser = fakeBrowserRS('unused');
  browser.screenshot = async () => persistBrowserScreenshot({
    mimeType: 'image/png',
    data: Buffer.from('screenshot').toString('base64'),
  }, workdir);
  const screenshotTool = createBrowserTools(browser)
    .find((toolItem) => toolItem.name === 'browser_screenshot');

  assert.ok(screenshotTool);

  const result = await screenshotTool.invoke(
    {},
    invocation('thread-1', workdir),
  );

  assert.ok(isCommand(result));
  const messages = (result.update as {
    messages: { _getType(): string; contentBlocks: { type: string }[] }[];
  }).messages;
  assert.deepEqual(messages.map((message) => message._getType()), ['tool', 'human']);
  assert.ok(messages[1]?.contentBlocks.some((block) => block.type === 'image'));
});
