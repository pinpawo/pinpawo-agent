import assert from 'node:assert/strict';
import test from 'node:test';
import {
  accessibilityLoaderKey,
  formatAccessibilityRef,
  isAccessibilityRef,
  parseAccessibilityRef,
} from './accessibilityRef';

const loaderId = '6A1F0C3E9B7D41C2A0E5F3B8C1D2E4F6';

test('accessibility refs round-trip a short document key, node and role', () => {
  const ref = formatAccessibilityRef(loaderId, 9, 'button');
  assert.equal(ref, 'ax:6A1F0C3E:9:button');
  assert.ok(isAccessibilityRef(ref!));
  assert.deepEqual(parseAccessibilityRef(ref!), {
    loaderKey: '6A1F0C3E',
    backendNodeId: 9,
    role: 'button',
  });
  assert.equal(parseAccessibilityRef(ref!)?.loaderKey, accessibilityLoaderKey(loaderId));
  assert.notEqual(accessibilityLoaderKey('FFFF0C3E9B7D41C2A0E5F3B8C1D2E4F6'), '6A1F0C3E');
});

test('no ref is made without a usable document or node (#869)', () => {
  assert.equal(formatAccessibilityRef(null, 9, 'button'), null);
  assert.equal(formatAccessibilityRef('has:colon:and-more', 9, 'button'), null);
  assert.equal(formatAccessibilityRef('SHORT', 9, 'button'), null);
  assert.equal(formatAccessibilityRef(loaderId, 0, 'button'), null);
  assert.equal(formatAccessibilityRef(loaderId, undefined, 'button'), null);
});

test('legacy and malformed accessibility refs are refused, not reinterpreted', () => {
  for (const ref of [
    'ax:9:button',
    'ax:6A1F:9:button',
    `ax:${loaderId}:9:button`,
    'ax:6A1F0C3E:0:button',
    'ax:6A1F0C3E:9:Button',
  ]) {
    assert.ok(isAccessibilityRef(ref));
    assert.equal(parseAccessibilityRef(ref), null, ref);
  }
  assert.equal(isAccessibilityRef('3f2c:1'), false);
});
