import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatAccessibilityRef,
  isAccessibilityRef,
  parseAccessibilityRef,
} from './accessibilityRef';

test('accessibility refs round-trip their document, node and role', () => {
  const ref = formatAccessibilityRef('6A1F0C3E9B', 9, 'button');
  assert.equal(ref, 'ax:6A1F0C3E9B:9:button');
  assert.ok(isAccessibilityRef(ref!));
  assert.deepEqual(parseAccessibilityRef(ref!), {
    loaderId: '6A1F0C3E9B',
    backendNodeId: 9,
    role: 'button',
  });
});

test('no ref is made without a usable document or node (#869)', () => {
  assert.equal(formatAccessibilityRef(null, 9, 'button'), null);
  assert.equal(formatAccessibilityRef('has:colon', 9, 'button'), null);
  assert.equal(formatAccessibilityRef('6A1F', 0, 'button'), null);
  assert.equal(formatAccessibilityRef('6A1F', undefined, 'button'), null);
});

test('legacy and malformed accessibility refs are refused, not reinterpreted', () => {
  for (const ref of ['ax:9:button', 'ax:6A1F:0:button', 'ax:bad-id:9:button', 'ax:6A1F:9:Button']) {
    assert.ok(isAccessibilityRef(ref));
    assert.equal(parseAccessibilityRef(ref), null, ref);
  }
  assert.equal(isAccessibilityRef('3f2c:1'), false);
});
