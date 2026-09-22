import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserToolkit } from './toolkit';

test('Browser keeps static tools without carrying Host Runtime assembly metadata', () => {
  const toolkit = createBrowserToolkit();
  assert.equal('runtime' in toolkit, false);
  assert.deepEqual(toolkit.tools.filter((definition) => definition.requiresInputModalities?.includes('image')).map((definition) => definition.tool.name), ['browser_screenshot']);
  const open = toolkit.tools.find((definition) => definition.tool.name === 'browser_open');
  assert.ok(open?.review);
  assert.equal(toolkit.tools.length, 12);
});
