import assert from 'node:assert/strict';
import test from 'node:test';
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

test('bound browser screenshot keeps image metadata as a tool artifact', () => {
  const screenshotTool = createBrowserTools(session('image')).find((toolItem) =>
    toolItem.name === 'browser_screenshot');

  assert.ok(screenshotTool);
  assert.equal(screenshotTool.responseFormat, 'content_and_artifact');
});
