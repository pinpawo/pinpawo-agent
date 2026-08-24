import assert from 'node:assert/strict';
import test from 'node:test';
import {
  listTuiCommands,
  parseTuiCommand,
} from './commandRegistry';

test('command registry exposes only implemented OpenTUI commands', () => {
  assert.deepEqual(
    listTuiCommands().map((command) => command.name),
    [
      'help',
      'new',
      'chat',
      'model',
      'policy',
      'transcript',
      'export',
      'edit',
      'refresh',
      'compact',
      'resume',
      'quit',
    ],
  );
});

test('command parser resolves commands and aliases', () => {
  const command = (name: string) => listTuiCommands()
    .find((candidate) => candidate.name === name);
  assert.equal(parseTuiCommand('/').type, 'command');
  assert.deepEqual(parseTuiCommand('/exit'), {
    type: 'command',
    command: command('quit'),
    name: 'quit',
    raw: '/exit',
    args: '',
  });
  assert.equal(parseTuiCommand('/ReSuMe').type, 'command');
  assert.equal(parseTuiCommand('/continue apply the new constraints').type, 'unknown');
  assert.deepEqual(parseTuiCommand('/export transcripts/today.md'), {
    type: 'command',
    command: command('export'),
    name: 'export',
    raw: '/export transcripts/today.md',
    args: 'transcripts/today.md',
  });
  assert.deepEqual(parseTuiCommand('/edit   draft text'), {
    type: 'command',
    command: command('edit'),
    name: 'edit',
    raw: '/edit   draft text',
    args: 'draft text',
  });
  assert.deepEqual(parseTuiCommand('/history'), {
    type: 'command',
    command: command('transcript'),
    name: 'transcript',
    raw: '/history',
    args: '',
  });
  assert.deepEqual(parseTuiCommand('/review-policy'), {
    type: 'command',
    command: command('policy'),
    name: 'policy',
    raw: '/review-policy',
    args: '',
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
