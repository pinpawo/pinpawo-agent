import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSystemPolicy,
  SYSTEM_POLICY_SOURCE,
  SYSTEM_POLICY_TARGET,
} from './systemPolicy';

test('buildSystemPolicy preserves trusted instruction order and emits content-free diagnostics', () => {
  const policy = buildSystemPolicy({
    target: SYSTEM_POLICY_TARGET.CAPABILITY,
    instructions: [
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
    ],
  });

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

test('buildSystemPolicy rejects duplicate and empty trusted instructions', () => {
  assert.throws(() => buildSystemPolicy({
    target: SYSTEM_POLICY_TARGET.ENTRY_ANSWER,
    instructions: [],
  }), /requires at least one instruction/);

  assert.throws(() => buildSystemPolicy({
    target: SYSTEM_POLICY_TARGET.CAPABILITY,
    instructions: [
      { id: 'same', source: SYSTEM_POLICY_SOURCE.FRAMEWORK, content: 'first' },
      { id: 'same', source: SYSTEM_POLICY_SOURCE.CAPABILITY, content: 'second' },
    ],
  }), /Duplicate System Policy instruction id/);
});

test('buildSystemPolicy keeps Planner variants finite', () => {
  assert.throws(() => buildSystemPolicy({
    target: SYSTEM_POLICY_TARGET.CAPABILITY_PLANNER,
    variant: 'retry' as 'entry',
    instructions: [{
      id: 'framework:planner',
      source: SYSTEM_POLICY_SOURCE.FRAMEWORK,
      content: 'planner policy',
    }],
  }), /requires entry or boundary variant/);
});
