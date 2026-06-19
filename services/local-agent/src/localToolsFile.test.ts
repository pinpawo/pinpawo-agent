import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createBashToolkit } from './toolkits/local';
import {
  applyPatchTool,
  copyPathTool,
  listDirTool,
  mkdirPathTool,
  movePathTool,
  readFileTool,
  statPathTool,
  validateStructuredFileTool,
  viewFileChunkTool,
  writeFileTool,
} from './toolkits/local/fileTools';
import { parsePatch, PatchParseError } from './toolkits/local/applyPatch';

function createFileFixture(t: TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), 'pinpawo-files-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function readJsonOutput(output: unknown) {
  return JSON.parse(String(output)) as Record<string, unknown>;
}

function reviewPolicyFor(toolName: string) {
  const policy = createBashToolkit().policy?.toolReview?.[toolName];
  assert.ok(policy);
  return policy;
}

function reviewContext(toolName: string, input: unknown) {
  const toolkit = createBashToolkit();
  return {
    models: {} as never,
    actor: {} as never,
    messages: [],
    toolkitName: 'bash',
    toolName,
    input,
    operation: toolkit.operations?.[toolName],
    reviewCapabilities: {
      humanReview: true,
      sessionAuthorization: true,
    },
  };
}

test('file tools write, view, and stat text files', async (t) => {
  const root = createFileFixture(t);
  const filePath = resolve(root, 'nested', 'note.txt');

  assert.equal(readJsonOutput(await writeFileTool.invoke({
    path: filePath,
    content: 'alpha\nbeta\ngamma\n',
  })).ok, true);

  assert.match(
    String(await readFileTool.invoke({ path: filePath })),
    /use view_file_chunk/,
  );
  assert.equal(
    await viewFileChunkTool.invoke({ path: filePath, startLine: 2, endLine: 3 }),
    '2: beta\n3: gamma',
  );

  const stat = readJsonOutput(await statPathTool.invoke({ path: filePath }));
  assert.equal(stat.type, 'file');
  assert.equal(stat.path, filePath);
});

test('bash toolkit reviews write_file with preset policy', async (t) => {
  const root = createFileFixture(t);
  const filePath = resolve(root, 'note.txt');
  writeFileSync(filePath, 'before\n', 'utf-8');
  const input = { path: filePath, content: 'after\n' };
  const policy = reviewPolicyFor('write_file');

  const review = await policy.request(reviewContext('write_file', input));
  assert.equal(review && 'schemaVersion' in review ? review.view.title : null, '写文件');
  assert.match(review && 'schemaVersion' in review ? review.view.body : '', new RegExp(filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(review && 'schemaVersion' in review ? review.view.body : '', /afterPreview/);
  assert.deepEqual(
    review && 'schemaVersion' in review ? review.options.map((option) => option.id) : [],
    ['approve', 'approve-and-authorize-thread', 'reject', 'respond'],
  );
});

test('bash toolkit reviews apply_patch with resolved file paths', async (t) => {
  const root = createFileFixture(t);
  const filePath = resolve(root, 'note.txt');
  const input = {
    patch: [
      '*** Begin Patch',
      `*** Update File: ${filePath}`,
      ' alpha',
      '-beta',
      '+BETA',
      '*** End Patch',
    ].join('\n'),
  };
  const policy = reviewPolicyFor('apply_patch');

  const review = await policy.request(reviewContext('apply_patch', input));
  assert.equal(review && 'schemaVersion' in review ? review.view.title : null, '应用补丁');
  assert.match(review && 'schemaVersion' in review ? review.view.body : '', /patch/);
  assert.match(review && 'schemaVersion' in review ? review.view.body : '', new RegExp(filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('bash toolkit reviews local path mutations with presets', () => {
  const toolkit = createBashToolkit();

  assert.equal(Boolean(toolkit.policy?.toolReview?.move_path), true);
  assert.equal(Boolean(toolkit.policy?.toolReview?.copy_path), true);
  assert.equal(Boolean(toolkit.policy?.toolReview?.mkdir_path), true);
});

test('bash toolkit leaves read-only file tools without review policy', () => {
  const toolkit = createBashToolkit();

  assert.equal(toolkit.policy?.toolReview?.read_file, undefined);
  assert.equal(toolkit.policy?.toolReview?.view_file_chunk, undefined);
  assert.equal(Boolean(toolkit.policy?.toolReview?.write_file), true);
  assert.equal(Boolean(toolkit.policy?.toolReview?.apply_patch), true);
});

test('bash toolkit write policy blocks without HITL support', async () => {
  const policy = reviewPolicyFor('write_file');
  const result = await policy.request({
    ...reviewContext('write_file', { path: '/tmp/a.txt', content: 'x' }),
    reviewCapabilities: {
      humanReview: false,
      sessionAuthorization: false,
    },
  });

  assert.equal(result && 'type' in result ? result.type : null, 'block');
});

test('apply_patch updates a file with context-anchored chunks', async (t) => {
  const root = createFileFixture(t);
  const filePath = resolve(root, 'note.txt');
  writeFileSync(filePath, 'alpha\nbeta\ngamma\ndelta\n', 'utf-8');

  const result = readJsonOutput(await applyPatchTool.invoke({
    patch: [
      '*** Begin Patch',
      `*** Update File: ${filePath}`,
      ' alpha',
      '-beta',
      '+BETA',
      ' gamma',
      '*** End Patch',
    ].join('\n'),
  }));

  assert.equal(result.ok, true);
  assert.deepEqual(result.files, [{ path: filePath, type: 'update', chunks: 1 }]);
  assert.equal(readFileSync(filePath, 'utf-8'), 'alpha\nBETA\ngamma\ndelta\n');
});

test('apply_patch applies multiple chunks with @@ anchors in one file', async (t) => {
  const root = createFileFixture(t);
  const filePath = resolve(root, 'code.ts');
  writeFileSync(filePath, [
    'function one() {',
    '  return 1;',
    '}',
    'function two() {',
    '  return 1;',
    '}',
    '',
  ].join('\n'), 'utf-8');

  const result = readJsonOutput(await applyPatchTool.invoke({
    patch: [
      '*** Begin Patch',
      `*** Update File: ${filePath}`,
      '@@ function two() {',
      '-  return 1;',
      '+  return 2;',
      '*** End Patch',
    ].join('\n'),
  }));

  assert.equal(result.ok, true);
  assert.equal(readFileSync(filePath, 'utf-8'), [
    'function one() {',
    '  return 1;',
    '}',
    'function two() {',
    '  return 2;',
    '}',
    '',
  ].join('\n'));
});

test('apply_patch tolerates whitespace drift in context lines', async (t) => {
  const root = createFileFixture(t);
  const filePath = resolve(root, 'drift.txt');
  writeFileSync(filePath, 'alpha   \n  beta\ngamma\n', 'utf-8');

  const result = readJsonOutput(await applyPatchTool.invoke({
    patch: [
      '*** Begin Patch',
      `*** Update File: ${filePath}`,
      ' alpha',
      '-beta',
      '+BETA',
      '*** End Patch',
    ].join('\n'),
  }));

  assert.equal(result.ok, true);
  const files = result.files as Array<Record<string, unknown>>;
  assert.equal(files[0]?.fuzz, 'ignore-whitespace');
  assert.equal(readFileSync(filePath, 'utf-8'), 'alpha\nBETA\ngamma\n');
});

test('apply_patch handles add, delete, and move in one patch', async (t) => {
  const root = createFileFixture(t);
  const keepPath = resolve(root, 'keep.txt');
  const dropPath = resolve(root, 'drop.txt');
  const addedPath = resolve(root, 'sub', 'added.txt');
  const renamedPath = resolve(root, 'renamed.txt');
  writeFileSync(keepPath, 'old name\n', 'utf-8');
  writeFileSync(dropPath, 'bye\n', 'utf-8');

  const result = readJsonOutput(await applyPatchTool.invoke({
    patch: [
      '*** Begin Patch',
      `*** Add File: ${addedPath}`,
      '+hello',
      '+world',
      `*** Delete File: ${dropPath}`,
      `*** Update File: ${keepPath}`,
      `*** Move to: ${renamedPath}`,
      '-old name',
      '+new name',
      '*** End Patch',
    ].join('\n'),
  }));

  assert.equal(result.ok, true);
  assert.equal(readFileSync(addedPath, 'utf-8'), 'hello\nworld');
  assert.equal(existsSync(dropPath), false);
  assert.equal(existsSync(keepPath), false);
  assert.equal(readFileSync(renamedPath, 'utf-8'), 'new name\n');
});

test('apply_patch reports missing context with closest-match hint', async (t) => {
  const root = createFileFixture(t);
  const filePath = resolve(root, 'note.txt');
  writeFileSync(filePath, 'alpha\nbeta variant\ngamma\n', 'utf-8');

  const output = String(await applyPatchTool.invoke({
    patch: [
      '*** Begin Patch',
      `*** Update File: ${filePath}`,
      '-beta original',
      '+BETA',
      '*** End Patch',
    ].join('\n'),
  }));

  assert.match(output, /^Error: chunk 1: context not found/);
  assert.match(output, /beta variant/);
  assert.equal(readFileSync(filePath, 'utf-8'), 'alpha\nbeta variant\ngamma\n');
});

test('apply_patch validates every file before touching any', async (t) => {
  const root = createFileFixture(t);
  const okPath = resolve(root, 'ok.txt');
  writeFileSync(okPath, 'fine\n', 'utf-8');

  const output = String(await applyPatchTool.invoke({
    patch: [
      '*** Begin Patch',
      `*** Update File: ${okPath}`,
      '-fine',
      '+changed',
      `*** Update File: ${resolve(root, 'missing.txt')}`,
      '-nope',
      '+never',
      '*** End Patch',
    ].join('\n'),
  }));

  assert.match(output, /^Error: Update File target is not an existing file/);
  assert.equal(readFileSync(okPath, 'utf-8'), 'fine\n');
});

test('apply_patch rejects malformed patches', async () => {
  assert.match(
    String(await applyPatchTool.invoke({ patch: 'not a patch' })),
    /must start with "\*\*\* Begin Patch"/,
  );
  assert.match(
    String(await applyPatchTool.invoke({
      patch: '*** Begin Patch\n*** End Patch',
    })),
    /contains no file operations/,
  );
  assert.throws(
    () => parsePatch('*** Begin Patch\n*** Update File: a.txt\n-old\n+new'),
    PatchParseError,
  );
});

test('parsePatch parses anchors, moves, and end-of-file markers', () => {
  const operations = parsePatch([
    '*** Begin Patch',
    '*** Update File: src/app.ts',
    '*** Move to: src/main.ts',
    '@@ function main()',
    ' context',
    '-old',
    '+new',
    '*** End of File',
    '*** End Patch',
  ].join('\n'));

  assert.equal(operations.length, 1);
  const update = operations[0];
  assert.equal(update?.type, 'update');
  if (update?.type !== 'update') return;
  assert.equal(update.moveTo, 'src/main.ts');
  assert.equal(update.chunks.length, 1);
  assert.equal(update.chunks[0]?.anchor, 'function main()');
  assert.deepEqual(update.chunks[0]?.oldLines, ['context', 'old']);
  assert.deepEqual(update.chunks[0]?.newLines, ['context', 'new']);
  assert.equal(update.chunks[0]?.isEndOfFile, true);
});

test('createBashToolkit registers review policies for file mutation tools', () => {
  const toolkit = createBashToolkit();

  assert.equal(Boolean(toolkit.policy?.toolReview?.write_file), true);
  assert.equal(Boolean(toolkit.policy?.toolReview?.apply_patch), true);
});

test('read_file analyzes non-text documents instead of reading text chunks', async (t) => {
  const root = createFileFixture(t);
  const filePath = resolve(root, 'report.pdf');
  writeFileSync(filePath, Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01, 0x02]));

  assert.match(
    String(await viewFileChunkTool.invoke({ path: filePath })),
    /not a UTF-8 text file/,
  );

  const result = readJsonOutput(await readFileTool.invoke({ path: filePath }));
  assert.equal(result.ok, false);
  assert.equal(result.type, 'document_or_binary');
  assert.equal(result.readableAsText, false);
  assert.match(String(result.reason), /No document reader/);
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
