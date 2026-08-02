import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { ToolMessage } from '@langchain/core/messages';
import { getLocalToolsWorkdir, setLocalToolsWorkdir } from '../local/pathUtils';
import { persistBrowserScreenshot } from './screenshot';
import { browserSession } from './session';
import { browserTools } from './tools';

process.env.LANGCHAIN_TRACING_V2 = 'false';
process.env.LANGSMITH_TRACING = 'false';

function readErrorCode(result: unknown): string | undefined {
  const parsed = JSON.parse(String(result)) as {
    error?: {
      code?: string;
    };
  };
  return parsed.error?.code;
}

test('browser tools require the delegation scope supplied through tool runtime', async () => {
  const snapshotTool = browserTools.find((toolItem) =>
    toolItem.name === 'browser_snapshot');
  assert.ok(snapshotTool);

  const missingScope = await snapshotTool.invoke({});
  assert.equal(readErrorCode(missingScope), 'browser_context_missing');

  const scoped = await snapshotTool.invoke({}, {
    context: {
      executionScope: {
        threadId: 'thread-1',
        runId: 'run-1',
        delegationId: 'delegation-1',
      },
    },
  });
  assert.equal(readErrorCode(scoped), 'browser_not_open');
});

test('browser screenshot manages its own graph message update', () => {
  const screenshotTool = browserTools.find((toolItem) =>
    toolItem.name === 'browser_screenshot');
  assert.ok(screenshotTool);
  assert.equal(screenshotTool.responseFormat, 'content');
});

test('browser screenshot directly returns an image tool result', async (t) => {
  const screenshotTool = browserTools.find((toolItem) =>
    toolItem.name === 'browser_screenshot');
  assert.ok(screenshotTool);

  const previousWorkdir = getLocalToolsWorkdir();
  const workdir = await mkdtemp(resolve(tmpdir(), 'pinpawo-browser-tool-'));
  const originalScreenshot = browserSession.screenshot;
  setLocalToolsWorkdir(workdir);
  browserSession.screenshot = async () => persistBrowserScreenshot({
    mimeType: 'image/png',
    data: Buffer.from('screenshot').toString('base64'),
  });
  t.after(() => {
    browserSession.screenshot = originalScreenshot;
    setLocalToolsWorkdir(previousWorkdir);
  });

  const admitted: string[][] = [];
  const result = await screenshotTool.invoke({}, {
    context: {
      executionScope: {
        threadId: 'thread-1',
        runId: 'run-1',
        delegationId: 'delegation-1',
      },
      admitInputModalities: (modalities: readonly ('text' | 'image')[]) => (
        admitted.push([...modalities])
      ),
    },
  });

  assert.ok(result instanceof ToolMessage);
  assert.deepEqual(admitted, [['text', 'image']]);
  assert.match(JSON.stringify(result.content), /"type":"input_image"/);
  assert.match(JSON.stringify(result.content), /data:image\/png;base64,/);
});
