import assert from 'node:assert/strict';
import test from 'node:test';
import {
  composeCapabilitySystemPolicy,
  SYSTEM_POLICY_SOURCE,
} from './systemPolicy';

test('composeCapabilitySystemPolicy preserves instruction order and emits content-free diagnostics', () => {
  const policy = composeCapabilitySystemPolicy([
    {
      id: 'framework:governing',
      source: SYSTEM_POLICY_SOURCE.FRAMEWORK,
      content: 'framework policy',
    },
    {
      id: 'toolkit:git',
      source: SYSTEM_POLICY_SOURCE.TOOLKIT,
      owner: 'git',
      content: 'toolkit policy',
    },
  ]);

  assert.equal(policy.message.text, 'framework policy\n\ntoolkit policy');
  assert.deepEqual(
    policy.diagnostics.instructions.map(({ id, source, owner }) => ({ id, source, owner })),
    [
      { id: 'framework:governing', source: 'framework', owner: null },
      { id: 'toolkit:git', source: 'toolkit', owner: 'git' },
    ],
  );
  assert.equal('content' in policy.diagnostics.instructions[0], false);
});

test('composeCapabilitySystemPolicy rejects duplicate and empty instructions', () => {
  assert.throws(() => composeCapabilitySystemPolicy([]), /requires at least one instruction/);

  assert.throws(() => composeCapabilitySystemPolicy([
    { id: 'same', source: SYSTEM_POLICY_SOURCE.FRAMEWORK, content: 'first' },
    { id: 'same', source: SYSTEM_POLICY_SOURCE.CAPABILITY, content: 'second' },
  ]), /Duplicate System Policy instruction id/);
});
