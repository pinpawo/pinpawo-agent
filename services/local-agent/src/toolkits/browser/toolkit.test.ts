import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkBrowserAvailability,
  getCachedBrowserAvailability,
} from './toolkit';

test('browser availability keeps its host health diagnostics', async () => {
  const availability = await checkBrowserAvailability();

  assert.equal(getCachedBrowserAvailability(), availability);
  assert.equal(typeof availability.available, 'boolean');
  if (availability.metadata) {
    assert.equal(typeof availability.metadata.mode, 'string');
  }
});
