import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTerminalCommand } from './commandLine';

test('terminal command parser preserves quoted arguments and escapes', () => {
  assert.deepEqual(parseTerminalCommand('code --wait "draft file.md"'), {
    command: 'code',
    args: ['--wait', 'draft file.md'],
  });
  assert.deepEqual(parseTerminalCommand('my\\ pager -R'), {
    command: 'my pager',
    args: ['-R'],
  });
  assert.equal(parseTerminalCommand('   '), null);
});

test('terminal command parser preserves Windows executable separators', () => {
  assert.deepEqual(parseTerminalCommand(
    '"C:\\Program Files\\Microsoft VS Code\\Code.exe" --wait',
    'win32',
  ), {
    command: 'C:\\Program Files\\Microsoft VS Code\\Code.exe',
    args: ['--wait'],
  });
  assert.deepEqual(parseTerminalCommand(
    '"C:\\Tools\\pager.exe" "--style=plain text"',
    'win32',
  ), {
    command: 'C:\\Tools\\pager.exe',
    args: ['--style=plain text'],
  });
  assert.equal(parseTerminalCommand(
    '"C:\\Program Files\\Editor\\editor.exe',
    'win32',
  ), null);
});
