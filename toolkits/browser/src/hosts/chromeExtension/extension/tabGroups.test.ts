import assert from 'node:assert/strict';
import test from 'node:test';
import {
  contextForGroup,
  contextGroupColor,
  contextGroupTitle,
  parsePersistedContextGroups,
} from './tabGroups';

test('context groups are titled after the site the session is on (#867)', () => {
  assert.equal(contextGroupTitle('https://github.com/pinpawo/pinpawo-agent/pulls'), '🐾 github.com');
  assert.equal(contextGroupTitle('https://www.example.com/'), '🐾 example.com');
  assert.equal(contextGroupTitle('http://127.0.0.1:5173/a'), '🐾 127.0.0.1');
  assert.equal(contextGroupTitle('https://mail.google.com/mail/u/0/'), '🐾 mail.google.com');
  for (const url of [null, undefined, '', 'about:blank', 'chrome://newtab/', 'not a url']) {
    assert.equal(contextGroupTitle(url), '🐾');
  }
});

test('context group colors rotate in creation order', () => {
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
      'context-b': { groupId: -1 },
      'context-c': {},
      '': { groupId: 5 },
    },
  }), {
    sequence: 3,
    groups: { 'context-a': { groupId: 17 } },
  });
  assert.equal(parsePersistedContextGroups({ sequence: -2, groups: [] }).sequence, 0);
});

test('a group id maps back to its context', () => {
  const groups = new Map([
    ['context-a', { groupId: 17 }],
    ['context-b', { groupId: 21 }],
  ]);
  assert.equal(contextForGroup(groups, 21), 'context-b');
  assert.equal(contextForGroup(groups, 99), null);
});
