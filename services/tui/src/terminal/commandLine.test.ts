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
