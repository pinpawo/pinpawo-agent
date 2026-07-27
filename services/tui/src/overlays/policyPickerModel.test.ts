import assert from 'node:assert/strict';
import test from 'node:test';
import stringWidth from 'string-width';
import {
  beginPolicySave,
  createPolicyPickerState,
  failPolicySave,
  formatPolicyMode,
  formatPolicyPicker,
  movePolicySelection,
  openPolicyPicker,
  resolvePolicyPickerKey,
  selectedPolicy,
} from './policyPickerModel';

test('policy picker opens on the authoritative current mode and navigates', () => {
  let state = openPolicyPicker(
    createPolicyPickerState(),
    'auto_authorization',
  );
  assert.equal(selectedPolicy(state)?.mode, 'auto_authorization');
  state = movePolicySelection(state, 1);
  assert.equal(selectedPolicy(state)?.mode, 'full_access');
  assert.equal(resolvePolicyPickerKey(state, key('return')), 'select');
  assert.equal(resolvePolicyPickerKey(state, key('escape')), 'close');
  assert.equal(resolvePolicyPickerKey(state, key('up')), 'move-up');
});

test('policy picker exposes saving and retryable errors within terminal width', () => {
  let state = openPolicyPicker(
    createPolicyPickerState(),
    'require_authorization',
  );
  state = beginPolicySave(state);
  assert.equal(resolvePolicyPickerKey(state, key('down')), null);
  state = failPolicySave(state, 'disk is unavailable');
  assert.equal(state.phase, 'error');
  assert.equal(resolvePolicyPickerKey(state, key('return')), 'select');
  for (const line of formatPolicyPicker(state, 28).split('\n')) {
    assert.ok(stringWidth(line) <= 24, line);
  }
});

test('policy modes have compact security labels', () => {
  assert.equal(formatPolicyMode('require_authorization'), 'ask');
  assert.equal(formatPolicyMode('auto_authorization'), 'auto');
  assert.equal(formatPolicyMode('full_access'), 'full');
});

function key(name: string, ctrl = false) {
  return { name, ctrl };
}
