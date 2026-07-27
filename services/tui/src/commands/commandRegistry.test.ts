import assert from 'node:assert/strict';
import test from 'node:test';
import {
  listTuiCommands,
  parseTuiCommand,
} from './commandRegistry';

test('command registry exposes only implemented OpenTUI commands', () => {
  assert.deepEqual(
    listTuiCommands().map((command) => command.name),
    ['help', 'new', 'studio', 'chat', 'resume', 'quit'],
  );
});

test('command parser resolves commands and aliases', () => {
  assert.equal(parseTuiCommand('/').type, 'command');
  assert.deepEqual(parseTuiCommand('/exit'), {
    type: 'command',
    command: listTuiCommands()[5],
    name: 'quit',
    raw: '/exit',
    args: '',
  });
  assert.equal(parseTuiCommand('/ReSuMe').type, 'command');
  assert.deepEqual(parseTuiCommand('/studio   ship the release '), {
    type: 'command',
    command: listTuiCommands()[2],
    name: 'studio',
    raw: '/studio   ship the release',
    args: 'ship the release',
  });
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
  assert.equal(parseTuiCommand('/help please').type, 'command');
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
