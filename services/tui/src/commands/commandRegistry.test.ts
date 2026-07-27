import assert from 'node:assert/strict';
import test from 'node:test';
import {
  listTuiCommands,
  parseTuiCommand,
} from './commandRegistry';

test('command registry exposes only implemented OpenTUI commands', () => {
  assert.deepEqual(
    listTuiCommands().map((command) => command.name),
    ['help', 'new', 'resume', 'quit'],
  );
});

test('command parser resolves commands and aliases', () => {
  assert.equal(parseTuiCommand('/').type, 'command');
  assert.deepEqual(parseTuiCommand('/exit'), {
    type: 'command',
    command: listTuiCommands()[3],
    name: 'quit',
    raw: '/exit',
  });
  assert.equal(parseTuiCommand('/ReSuMe').type, 'command');
});

test('command parser keeps paths and slash-prefixed prose as chat text', () => {
  assert.deepEqual(parseTuiCommand('/Users/mac/file.txt'), {
    type: 'text',
    text: '/Users/mac/file.txt',
  });
  assert.deepEqual(parseTuiCommand('// comment'), {
    type: 'text',
    text: '// comment',
  });
  assert.deepEqual(parseTuiCommand('/123'), {
    type: 'text',
    text: '/123',
  });
  assert.deepEqual(parseTuiCommand('/help please'), {
    type: 'text',
    text: '/help please',
  });
  assert.deepEqual(parseTuiCommand('  code block  '), {
    type: 'text',
    text: '  code block  ',
  });
  assert.deepEqual(parseTuiCommand('/missing'), {
    type: 'unknown',
    raw: '/missing',
    name: 'missing',
  });
});
