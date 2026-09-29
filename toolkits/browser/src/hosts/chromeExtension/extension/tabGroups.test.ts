import assert from 'node:assert/strict';
import test from 'node:test';
import {
  contextForGroup,
  contextGroupColor,
  contextGroupLabel,
  parsePersistedContextGroups,
} from './tabGroups';

test('context groups are named by sequence with rotating colors (#867)', () => {
  assert.equal(contextGroupLabel(1), 'PinPawo 1');
  assert.equal(contextGroupLabel(12), 'PinPawo 12');
  assert.equal(contextGroupColor(1), 'blue');
  assert.equal(contextGroupColor(2), 'green');
  assert.equal(contextGroupColor(10), 'blue');
});

test('stored context groups are read defensively', () => {
  assert.deepEqual(parsePersistedContextGroups(undefined), { sequence: 0, groups: {} });
  assert.deepEqual(parsePersistedContextGroups({
    sequence: 3,
    groups: {
      'context-a': { groupId: 17, label: 'PinPawo 2' },
      'context-b': { groupId: -1, label: 'bad' },
      'context-c': { groupId: 4 },
      '': { groupId: 5, label: 'no id' },
    },
  }), {
    sequence: 3,
    groups: { 'context-a': { groupId: 17, label: 'PinPawo 2' } },
  });
  assert.equal(parsePersistedContextGroups({ sequence: -2, groups: [] }).sequence, 0);
});

test('a group id maps back to its context', () => {
  const groups = new Map([
    ['context-a', { groupId: 17, label: 'PinPawo 1' }],
    ['context-b', { groupId: 21, label: 'PinPawo 2' }],
  ]);
  assert.equal(contextForGroup(groups, 21), 'context-b');
  assert.equal(contextForGroup(groups, 99), null);
});
