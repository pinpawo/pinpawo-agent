import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCapabilityEnabled } from './capabilityActivation';

const disabledByDefault = {
  id: 'disabled-by-default',
  defaultEnabled: false,
};

test('resolveCapabilityEnabled uses the authored default when no override exists', () => {
  assert.equal(resolveCapabilityEnabled(disabledByDefault, {}), false);
});

test('resolveCapabilityEnabled applies an explicit stored override', () => {
  assert.equal(resolveCapabilityEnabled(disabledByDefault, {
    capabilities: { 'disabled-by-default': true },
  }), true);
});
