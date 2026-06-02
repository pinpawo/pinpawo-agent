import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  applyFilePatchTool,
  copyPathTool,
  listDirTool,
  mkdirPathTool,
  movePathTool,
  multiEditTool,
  readFileTool,
  statPathTool,
  updateFileTool,
  validateStructuredFileTool,
  viewFileChunkTool,
  writeFileTool,
} from './plugins/localTools/fileTools';

function createFileFixture(t: TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), 'pinpawo-files-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function readJsonOutput(output: unknown) {
  return JSON.parse(String(output)) as Record<string, unknown>;
}

test('file tools write, read, view, stat, update, and patch text files', async (t) => {
  const root = createFileFixture(t);
  const filePath = resolve(root, 'nested', 'note.txt');

  assert.equal(readJsonOutput(await writeFileTool.invoke({
    path: filePath,
    content: 'alpha\nbeta\ngamma\n',
  })).ok, true);

  assert.equal(await readFileTool.invoke({ path: filePath }), 'alpha\nbeta\ngamma\n');
  assert.equal(
    await viewFileChunkTool.invoke({ path: filePath, startLine: 2, endLine: 3 }),
    '2: beta\n3: gamma',
  );

  const stat = readJsonOutput(await statPathTool.invoke({ path: filePath }));
  assert.equal(stat.type, 'file');
  assert.equal(stat.path, filePath);

  assert.equal(readJsonOutput(await updateFileTool.invoke({
    path: filePath,
    find: 'beta',
    replace: 'BETA',
  })).replaced, 1);
  assert.equal(readFileSync(filePath, 'utf-8'), 'alpha\nBETA\ngamma\n');

  assert.equal(readJsonOutput(await multiEditTool.invoke({
    path: filePath,
    edits: [
      { find: 'alpha', replace: 'ALPHA' },
      { find: 'gamma', replace: 'GAMMA' },
    ],
  })).replaced, 2);

  assert.deepEqual(
    readJsonOutput(await applyFilePatchTool.invoke({
      path: filePath,
      hunks: [{
        oldText: 'ALPHA\nBETA',
        newText: 'one\ntwo',
        expectedOccurrences: 1,
      }],
    })).hunks,
    [{ index: 0, replaced: 1, replaceAll: false }],
  );
  assert.equal(readFileSync(filePath, 'utf-8'), 'one\ntwo\nGAMMA\n');
});

test('file tools validate JSON and manage local paths', async (t) => {
  const root = createFileFixture(t);
  const source = resolve(root, 'source.json');
  const copies = resolve(root, 'copies');
  const moved = resolve(root, 'moved');

  writeFileSync(source, JSON.stringify({
    id: 'cap',
    name: 'Capability',
    description: 'desc',
    icon: 'sparkle',
    color: '#fff',
    defaultEnabled: true,
    builtIn: false,
  }), 'utf-8');

  assert.equal(readJsonOutput(await validateStructuredFileTool.invoke({
    path: source,
    schema: 'capability_manifest',
  })).ok, true);

  assert.equal(readJsonOutput(await mkdirPathTool.invoke({ path: copies })).ok, true);
  assert.equal(readJsonOutput(await copyPathTool.invoke({
    source,
    destination: copies,
  })).destination, resolve(copies, 'source.json'));

  const listing = String(await listDirTool.invoke({ path: copies }));
  assert.match(listing, /f source\.json/);

  assert.equal(readJsonOutput(await mkdirPathTool.invoke({ path: moved })).ok, true);
  assert.equal(readJsonOutput(await movePathTool.invoke({
    source: resolve(copies, 'source.json'),
    destination: moved,
  })).destination, resolve(moved, 'source.json'));
  assert.equal(existsSync(resolve(copies, 'source.json')), false);
  assert.equal(existsSync(resolve(moved, 'source.json')), true);
});
