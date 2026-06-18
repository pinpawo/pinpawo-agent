import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  editTextWithExternalEditor,
  resolveExternalEditorCommand,
  type ExternalEditorSpawn,
} from './externalEditor';

test('resolveExternalEditorCommand prefers VISUAL and parses editor args', () => {
  assert.deepEqual(
    resolveExternalEditorCommand({
      VISUAL: 'code --wait',
      EDITOR: 'vim',
    }),
    { command: 'code', args: ['--wait'] },
  );
  assert.deepEqual(
    resolveExternalEditorCommand({ EDITOR: '"my editor" --flag' }),
    { command: 'my editor', args: ['--flag'] },
  );
  assert.equal(resolveExternalEditorCommand({}), null);
});

test('editTextWithExternalEditor writes initial text and reads edited content', async () => {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'pinpawo-editor-test-'));
  const spawnEditor: ExternalEditorSpawn = (_command, args) => {
    const filePath = args.at(-1);
    assert.equal(typeof filePath, 'string');
    assert.equal(readFileSyncText(filePath as string), 'draft');
    writeFileSync(filePath as string, 'edited\n');
    const child = new EventEmitter();
    setImmediate(() => child.emit('exit', 0, null));
    return child as ReturnType<ExternalEditorSpawn>;
  };

  assert.equal(
    await editTextWithExternalEditor({
      initialText: 'draft',
      cwd: tmpRoot,
      tmpRoot,
      env: { EDITOR: 'test-editor' },
      spawnEditor,
    }),
    'edited\n',
  );
});

test('editTextWithExternalEditor rejects when no editor is configured', async () => {
  await assert.rejects(
    () => editTextWithExternalEditor({
      initialText: '',
      cwd: process.cwd(),
      env: {},
    }),
    /missing VISUAL or EDITOR/,
  );
});

function readFileSyncText(filePath: string) {
  return readFileSync(filePath, 'utf-8');
}
