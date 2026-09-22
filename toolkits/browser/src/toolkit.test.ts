import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserToolkit } from './toolkit';

test('Browser declares CDP and keeps static tools without constructing a runtime', () => {
  const toolkit = createBrowserToolkit();
  assert.equal(toolkit.runtime, 'cdp');
  assert.deepEqual(toolkit.tools.filter((definition) => definition.requiresInputModalities?.includes('image')).map((definition) => definition.tool.name), ['browser_screenshot']);
  const open = toolkit.tools.find((definition) => definition.tool.name === 'browser_open');
  assert.ok(open?.review);
  assert.equal(toolkit.tools.length, 12);
});
