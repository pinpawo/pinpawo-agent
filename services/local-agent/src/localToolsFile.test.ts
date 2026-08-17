import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { AgentToolkit } from '@pinpawo/pet-agent';
import { createBashToolkit } from './toolkits/local';
import {
  applyPatchTool as rawApplyPatchTool,
  copyPathTool,
  fileOperationMetadata,
  listDirTool,
  mkdirPathTool,
  movePathTool,
  readFileTool,
  statPathTool,
  validateStructuredFileTool,
  viewFileChunkTool,
  VIEW_FILE_CHUNK_MAX_BYTES,
  writeFileTool,
} from './toolkits/local/fileTools';
import {
  parsePatch,
  PatchParseError,
} from './toolkits/local/applyPatch';

function definition(toolkit: AgentToolkit, toolName: string) {
  return toolkit.tools.find((item) => item.tool.name === toolName);
}

function createFileFixture(t: TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), 'pinpawo-files-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function readJsonOutput(output: unknown) {
  return JSON.parse(String(output)) as Record<string, unknown>;
}

const applyPatchTool = rawApplyPatchTool;

function reviewPolicyFor(toolName: string) {
  const policy = definition(createBashToolkit(), toolName)?.review;
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
    operation: definition(toolkit, toolName)?.operation,
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
    '2: beta\n3: gamma\n\n[lines 2-3 of 4; nextStartLine=4]',
  );

  const stat = readJsonOutput(await statPathTool.invoke({ path: filePath }));
  assert.equal(stat.type, 'file');
  assert.equal(stat.path, filePath);
});

test('view_file_chunk reports resumable actual ranges and completion', async (t) => {
  const root = createFileFixture(t);
  const filePath = resolve(root, 'long.txt');
  writeFileSync(
    filePath,
    Array.from({ length: 450 }, (_, index) => `line ${index + 1}`).join('\n'),
    'utf-8',
  );

  const first = String(await viewFileChunkTool.invoke({ path: filePath }));
  assert.match(first, /\[lines 1-200 of 450; nextStartLine=201\]$/);

  const last = String(await viewFileChunkTool.invoke({
    path: filePath,
    startLine: 401,
  }));
  assert.match(last, /\[lines 401-450 of 450; complete\]$/);
});

test('view_file_chunk reports totalLines when startLine is out of range', async (t) => {
  const root = createFileFixture(t);
  const filePath = resolve(root, 'short.txt');
  writeFileSync(filePath, 'one\ntwo\nthree', 'utf-8');

  const output = String(await viewFileChunkTool.invoke({ path: filePath, startLine: 4 }));
  assert.equal(output, 'Error: startLine 4 is outside the file; totalLines=3');
});

test('view_file_chunk bounds an oversized single line without a false cursor', async (t) => {
  const root = createFileFixture(t);
  const filePath = resolve(root, 'minified.js');
  writeFileSync(filePath, `const value = '${'界'.repeat(80_000)}';`, 'utf-8');

  const output = String(await viewFileChunkTool.invoke({ path: filePath }));
  assert.ok(
    Buffer.byteLength(output, 'utf-8') <= VIEW_FILE_CHUNK_MAX_BYTES,
    `output exceeded ${VIEW_FILE_CHUNK_MAX_BYTES} bytes`,
  );
  assert.match(output, /incomplete: line 1 cannot fit within 50000-byte result limit/);
  assert.match(output, /nextStartLine=unavailable/);
  assert.doesNotMatch(output, /complete\]$/);
});

test('view_file_chunk byte truncation returns a cursor that advances', async (t) => {
  const root = createFileFixture(t);
  const filePath = resolve(root, 'wide.txt');
  writeFileSync(
    filePath,
    Array.from({ length: 100 }, (_, index) => `${index + 1} ${'界'.repeat(400)}`).join('\n'),
    'utf-8',
  );

  const first = String(await viewFileChunkTool.invoke({ path: filePath }));
  assert.ok(Buffer.byteLength(first, 'utf-8') <= VIEW_FILE_CHUNK_MAX_BYTES);
  const cursor = /nextStartLine=(\d+)/.exec(first)?.[1];
  assert.ok(cursor, 'expected a resumable nextStartLine');
  assert.match(first, /stopped at 50000-byte limit/);

  const resumed = String(await viewFileChunkTool.invoke({
    path: filePath,
    startLine: Number(cursor),
  }));
  assert.match(resumed, new RegExp(`^${cursor}: `));
});

test('view_file_chunk reserves space for the final byte-limit footer', async (t) => {
  const root = createFileFixture(t);
  const filePath = resolve(root, 'footer-boundary.txt');
  writeFileSync(
    filePath,
    Array.from({ length: 62 }, () => 'x'.repeat(814)).join('\n'),
    'utf-8',
  );

  const output = String(await viewFileChunkTool.invoke({ path: filePath }));
  assert.ok(Buffer.byteLength(output, 'utf-8') <= VIEW_FILE_CHUNK_MAX_BYTES);
  assert.match(output, /nextStartLine=\d+; stopped at 50000-byte limit/);
});

test('bash toolkit reviews write_file with preset policy', async (t) => {
  const root = createFileFixture(t);
  const filePath = resolve(root, 'note.txt');
  writeFileSync(filePath, 'before\n', 'utf-8');
  const input = { path: filePath, content: 'after\n' };
  const policy = reviewPolicyFor('write_file');
  const context = reviewContext('write_file', input);
  const buildMatcher = policy.authorization?.buildMatcher;
  assert.ok(buildMatcher);
  const authorizationMatcher = await buildMatcher(context);

  const review = await policy.request({
    ...context,
    authorizationMatcher,
  });
  const view = review && 'schemaVersion' in review ? review.view : null;
  assert.ok(view && view.kind === 'plain');
  assert.equal(view.title, '写文件');
  assert.match(view.body, new RegExp(filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(view.body, /afterPreview/);
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
      '@@',
      ' alpha',
      '-beta',
      '+BETA',
      '*** End Patch',
    ].join('\n'),
  };
  const policy = reviewPolicyFor('apply_patch');

  const review = await policy.request(reviewContext('apply_patch', input));
  const view = review && 'schemaVersion' in review ? review.view : null;
  assert.ok(view && view.kind === 'diff');
  assert.equal(view.title, '应用补丁');
  assert.match(view.patch, /\*\*\* Update File/);
  assert.match(view.target ?? '', new RegExp(filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('auto review deterministically authorizes safe apply_patch execution', async (t) => {
  const root = createFileFixture(t);
  const outsideRoot = createFileFixture(t);
  const insidePath = resolve(root, 'inside.txt');
  const outsidePath = resolve(outsideRoot, 'outside.txt');
  writeFileSync(insidePath, 'before\n', 'utf-8');
  writeFileSync(outsidePath, 'before\n', 'utf-8');

  const policy = reviewPolicyFor('apply_patch');
  const authorize = policy.authorization?.authorize;
  assert.ok(authorize);
  assert.equal(policy.authorization?.buildMatcher, undefined);
  const patchInput = (path: string) => ({
    patch: [
      '*** Begin Patch',
      `*** Update File: ${path}`,
      '@@',
      '-before',
      '+after',
      '*** End Patch',
    ].join('\n'),
  });

  assert.equal(await authorize({
    ...reviewContext('apply_patch', patchInput(insidePath)),
    workdir: root,
  }), true);
  assert.equal(await authorize({
    ...reviewContext('apply_patch', patchInput('inside.txt')),
    workdir: root,
  }), true);
  assert.equal(await authorize({
    ...reviewContext('apply_patch', patchInput(outsidePath)),
    workdir: root,
  }), false);
  if (process.platform !== 'win32') {
    const linkedOutside = resolve(root, 'linked-outside');
    symlinkSync(outsideRoot, linkedOutside, 'dir');
    assert.equal(await authorize({
      ...reviewContext('apply_patch', patchInput(resolve(linkedOutside, 'outside.txt'))),
      workdir: root,
    }), false);
  }
  assert.equal(await authorize({
    ...reviewContext('apply_patch', { patch: 'not V4A' }),
    workdir: root,
  }), true);
  assert.equal(await authorize({
    ...reviewContext('apply_patch', {}),
    workdir: root,
  }), false);
});

test('bash toolkit reviews local path mutations with presets', () => {
  const toolkit = createBashToolkit();

  assert.equal(Boolean(definition(toolkit, 'move_path')?.review), true);
  assert.equal(Boolean(definition(toolkit, 'copy_path')?.review), true);
  assert.equal(Boolean(definition(toolkit, 'mkdir_path')?.review), true);
});

test('file operation metadata preserves model-provided relative paths', () => {
  const summary = fileOperationMetadata.write_file?.summarizeInput?.({
    path: 'notes/todo.md',
    content: 'todo',
  });
  assert.equal(summary?.target, 'notes/todo.md');
  assert.equal(summary?.details?.before, undefined);
});

test('bash toolkit leaves read-only file tools without review policy', () => {
  const toolkit = createBashToolkit();

  assert.equal(definition(toolkit, 'read_file')?.review, undefined);
  assert.equal(definition(toolkit, 'view_file_chunk')?.review, undefined);
  assert.equal(Boolean(definition(toolkit, 'write_file')?.review), true);
  assert.equal(Boolean(definition(toolkit, 'apply_patch')?.review), true);
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
      '@@',
      ' alpha',
      '-beta',
      '+BETA',
      ' gamma',
      '*** End Patch',
    ].join('\n'),
  }));

  assert.equal(result.ok, true);
  assert.deepEqual(result.file, { path: filePath, chunks: 1 });
  assert.deepEqual(result.appliedHunks, [1]);
  assert.equal('failedHunks' in result, false);
  assert.equal(readFileSync(filePath, 'utf-8'), 'alpha\nBETA\ngamma\ndelta\n');
});

test('apply_patch rejects Unified Diff without modifying the file', async (t) => {
  const root = createFileFixture(t);
  const filePath = resolve(root, 'note.txt');
  const original = 'alpha\nbeta\ngamma\ndelta\n';
  writeFileSync(filePath, original, 'utf-8');

  const result = readJsonOutput(await applyPatchTool.invoke({
    patch: [
      `--- ${filePath}`,
      `+++ ${filePath}`,
      '@@ -99,30 +42,80 @@',
      ' alpha',
      '-beta',
      '+BETA',
      ' gamma',
    ].join('\n'),
  }));

  assert.equal(result.ok, false);
  assert.equal(result.phase, 'parse');
  assert.equal(result.code, 'invalid_patch_syntax');
  assert.equal('format' in result, false);
  assert.equal(readFileSync(filePath, 'utf-8'), original);
});

test('apply_patch preserves CRLF while tolerating whitespace drift in V4A', async (t) => {
  const root = createFileFixture(t);
  const filePath = resolve(root, 'windows.txt');
  writeFileSync(filePath, 'alpha   \r\nbeta\r\ngamma\r\n', 'utf-8');

  const result = readJsonOutput(await applyPatchTool.invoke({
    patch: [
      '*** Begin Patch',
      `*** Update File: ${filePath}`,
      '@@',
      ' alpha',
      '-beta',
      '+BETA',
      ' gamma',
      '*** End Patch',
    ].join('\n'),
  }));

  assert.equal(result.ok, true);
  assert.equal(readFileSync(filePath, 'utf-8'), 'alpha   \r\nBETA\r\ngamma\r\n');
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

test('V4A treats bare blank lines as context inside a hunk and separators at boundaries', async (t) => {
  const root = createFileFixture(t);
  const filePath = resolve(root, 'blank-lines.txt');
  writeFileSync(filePath, 'alpha\n\nbeta\nomega\n', 'utf-8');

  const result = readJsonOutput(await applyPatchTool.invoke({
    patch: [
      '*** Begin Patch',
      `*** Update File: ${filePath}`,
      '@@',
      ' alpha',
      '',
      '-beta',
      '+BETA',
      '',
      '@@',
      '-omega',
      '+OMEGA',
      '',
      '*** End Patch',
    ].join('\n'),
  }));

  assert.equal(result.ok, true);
  assert.deepEqual(result.appliedHunks, [1, 2]);
  assert.equal(readFileSync(filePath, 'utf-8'), 'alpha\n\nBETA\nOMEGA\n');
});

test('V4A end-of-file insertion and replacement preserve the final newline', async (t) => {
  const root = createFileFixture(t);
  const insertPath = resolve(root, 'insert-at-eof.txt');
  const replacePath = resolve(root, 'replace-at-eof.txt');
  writeFileSync(insertPath, 'head\n', 'utf-8');
  writeFileSync(replacePath, 'head\n', 'utf-8');

  const insertion = readJsonOutput(await applyPatchTool.invoke({
    patch: [
      '*** Begin Patch',
      `*** Update File: ${insertPath}`,
      '@@',
      '+tail',
      '*** End of File',
      '*** End Patch',
    ].join('\n'),
  }));
  const replacement = readJsonOutput(await applyPatchTool.invoke({
    patch: [
      '*** Begin Patch',
      `*** Update File: ${replacePath}`,
      '@@',
      '-head',
      '+HEAD',
      '*** End of File',
      '*** End Patch',
    ].join('\n'),
  }));

  assert.equal(insertion.ok, true);
  assert.equal(replacement.ok, true);
  assert.equal(readFileSync(insertPath, 'utf-8'), 'head\ntail\n');
  assert.equal(readFileSync(replacePath, 'utf-8'), 'HEAD\n');
});

test('V4A applies hunks monotonically and discloses a later backward match', async (t) => {
  const root = createFileFixture(t);
  const filePath = resolve(root, 'ordered.txt');
  writeFileSync(filePath, 'top\nmid\nbottom\n', 'utf-8');

  const result = readJsonOutput(await applyPatchTool.invoke({
    patch: [
      '*** Begin Patch',
      `*** Update File: ${filePath}`,
      '@@ mid',
      '-bottom',
      '+BOTTOM',
      '@@',
      '-top',
      '+TOP',
      '*** End Patch',
    ].join('\n'),
  }));

  assert.equal(result.ok, false);
  assert.equal(result.partial, true);
  assert.deepEqual(result.appliedHunks, [1]);
  assert.equal((result.failedHunks as Array<Record<string, unknown>>)[0]?.hunk, 2);
  assert.equal((result.failedHunks as Array<Record<string, unknown>>)[0]?.diff, '@@\n-top\n+TOP');
  assert.equal(readFileSync(filePath, 'utf-8'), 'top\nmid\nBOTTOM\n');
});

test('V4A discloses each hunk outcome and accepts a later correction', async (t) => {
  const root = createFileFixture(t);
  const filePath = resolve(root, 'partial.txt');
  writeFileSync(filePath, [
    'alpha',
    'old one',
    'middle',
    'actual two',
    'omega',
    '',
  ].join('\n'), 'utf-8');

  const partial = readJsonOutput(await applyPatchTool.invoke({
    patch: [
      '*** Begin Patch',
      `*** Update File: ${filePath}`,
      '@@ alpha',
      '-old one',
      '+new one',
      '@@ middle',
      '-actual two stale',
      '+new two',
      '@@ actual two',
      '-omega',
      '+OMEGA',
      '*** End Patch',
    ].join('\n'),
  }));

  assert.equal(partial.ok, false);
  assert.equal(partial.partial, true);
  assert.equal(partial.code, 'partial_patch_applied');
  assert.deepEqual(partial.file, { path: filePath, chunks: 2 });
  assert.deepEqual(partial.appliedHunks, [1, 3]);
  assert.equal('chunks' in partial, false);
  const failed = (partial.failedHunks as Array<Record<string, unknown>>)[0];
  assert.equal(failed?.hunk, 2);
  assert.equal(failed?.code, 'context_not_found');
  assert.equal(failed?.diff, '@@ middle\n-actual two stale\n+new two');
  assert.equal('expected' in (failed ?? {}), false);
  assert.match(JSON.stringify(failed?.closest), /actual two/);
  assert.equal('nextAction' in partial, false);
  assert.equal(readFileSync(filePath, 'utf-8'), [
    'alpha',
    'new one',
    'middle',
    'actual two',
    'OMEGA',
    '',
  ].join('\n'));

  const retry = readJsonOutput(await applyPatchTool.invoke({
    patch: [
      '*** Begin Patch',
      `*** Update File: ${filePath}`,
      '@@ middle',
      '-actual two',
      '+new two',
      '*** End Patch',
    ].join('\n'),
  }));

  assert.equal(retry.ok, true);
  assert.deepEqual(retry.file, { path: filePath, chunks: 1 });
  assert.equal(readFileSync(filePath, 'utf-8'), [
    'alpha',
    'new one',
    'middle',
    'new two',
    'OMEGA',
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
      '@@',
      ' alpha',
      '-beta',
      '+BETA',
      '*** End Patch',
    ].join('\n'),
  }));

  assert.equal(result.ok, true);
  const file = result.file as Record<string, unknown>;
  assert.equal(file.fuzz, 'ignore-whitespace');
  assert.equal(readFileSync(filePath, 'utf-8'), 'alpha   \nBETA\ngamma\n');
});

test('apply_patch preserves original indentation on fuzzy-matched context lines', async (t) => {
  const root = createFileFixture(t);
  const filePath = resolve(root, 'config.py');
  writeFileSync(filePath, [
    '@dataclass(frozen=True)',
    'class AppConfig:',
    '    profile: str',
    '    region_id: str',
    '    product: str',
    '',
  ].join('\n'), 'utf-8');

  const result = readJsonOutput(await applyPatchTool.invoke({
    patch: [
      '*** Begin Patch',
      `*** Update File: ${filePath}`,
      '@@',
      ' @dataclass(frozen=True)',
      ' class AppConfig:',
      '-   profile: str',
      '+    profile: str = "dev"',
      '    region_id: str',
      '    product: str',
      '*** End Patch',
    ].join('\n'),
  }));

  assert.equal(result.ok, true);
  const file = result.file as Record<string, unknown>;
  assert.equal(file.fuzz, 'ignore-whitespace');
  assert.equal(readFileSync(filePath, 'utf-8'), [
    '@dataclass(frozen=True)',
    'class AppConfig:',
    '    profile: str = "dev"',
    '    region_id: str',
    '    product: str',
    '',
  ].join('\n'));
});

test('apply_patch rejects V4A file additions, deletions, and moves', async (t) => {
  const root = createFileFixture(t);
  const keepPath = resolve(root, 'keep.txt');
  const dropPath = resolve(root, 'drop.txt');
  const addedPath = resolve(root, 'sub', 'added.txt');
  const renamedPath = resolve(root, 'renamed.txt');
  writeFileSync(keepPath, 'old name\n', 'utf-8');
  writeFileSync(dropPath, 'bye\n', 'utf-8');

  const addResult = readJsonOutput(await applyPatchTool.invoke({
    patch: [
      '*** Begin Patch',
      `*** Add File: ${addedPath}`,
      '+hello',
      '+world',
      '*** End Patch',
    ].join('\n'),
  }));
  const deleteResult = readJsonOutput(await applyPatchTool.invoke({
    patch: [
      '*** Begin Patch',
      `*** Delete File: ${dropPath}`,
      '*** End Patch',
    ].join('\n'),
  }));
  const moveResult = readJsonOutput(await applyPatchTool.invoke({
    patch: [
      '*** Begin Patch',
      `*** Update File: ${keepPath}`,
      `*** Move to: ${renamedPath}`,
      '-old name',
      '+new name',
      '*** End Patch',
    ].join('\n'),
  }));

  assert.equal(addResult.ok, false);
  assert.equal(deleteResult.ok, false);
  assert.equal(moveResult.ok, false);
  assert.equal(addResult.code, 'unsupported_file_operation');
  assert.equal(deleteResult.code, 'unsupported_file_operation');
  assert.equal(moveResult.code, 'unsupported_file_operation');
  assert.equal(existsSync(addedPath), false);
  assert.equal(readFileSync(dropPath, 'utf-8'), 'bye\n');
  assert.equal(readFileSync(keepPath, 'utf-8'), 'old name\n');
  assert.equal(existsSync(renamedPath), false);
});

test('apply_patch reports structured missing context with closest-match hint', async (t) => {
  const root = createFileFixture(t);
  const filePath = resolve(root, 'note.txt');
  writeFileSync(filePath, 'alpha\nbeta variant\ngamma\n', 'utf-8');

  const output = readJsonOutput(await applyPatchTool.invoke({
    patch: [
      '*** Begin Patch',
      `*** Update File: ${filePath}`,
      '@@',
      '-beta original',
      '+BETA',
      '*** End Patch',
    ].join('\n'),
  }));

  assert.equal(output.ok, false);
  assert.equal(output.phase, 'match');
  assert.equal(output.code, 'context_not_found');
  assert.deepEqual(output.appliedHunks, []);
  const failed = (output.failedHunks as Array<Record<string, unknown>>)[0];
  assert.equal(failed?.hunk, 1);
  assert.equal(failed?.diff, '@@\n-beta original\n+BETA');
  assert.match(JSON.stringify(failed?.closest), /beta variant/);
  assert.equal('nextAction' in output, false);
  assert.equal(readFileSync(filePath, 'utf-8'), 'alpha\nbeta variant\ngamma\n');
});

test('V4A rejects ambiguous hunk context and discloses its diff', async (t) => {
  const root = createFileFixture(t);
  const filePath = resolve(root, 'repeated-v4a.txt');
  const original = 'alpha\nbeta\ngamma\nalpha\nbeta\ngamma\n';
  writeFileSync(filePath, original, 'utf-8');

  const output = readJsonOutput(await applyPatchTool.invoke({
    patch: [
      '*** Begin Patch',
      `*** Update File: ${filePath}`,
      '@@',
      ' alpha',
      '-beta',
      '+BETA',
      ' gamma',
      '*** End Patch',
    ].join('\n'),
  }));

  assert.equal(output.ok, false);
  assert.equal(output.partial, false);
  assert.equal(output.code, 'ambiguous_context');
  assert.equal(
    (output.failedHunks as Array<Record<string, unknown>>)[0]?.diff,
    '@@\n alpha\n-beta\n+BETA\n gamma',
  );
  assert.deepEqual(
    (output.failedHunks as Array<Record<string, unknown>>)[0]?.matches,
    [1, 4],
  );
  assert.equal(readFileSync(filePath, 'utf-8'), original);
});

test('apply_patch rejects multiple V4A file updates without touching any file', async (t) => {
  const root = createFileFixture(t);
  const okPath = resolve(root, 'ok.txt');
  writeFileSync(okPath, 'fine\n', 'utf-8');

  const output = readJsonOutput(await applyPatchTool.invoke({
    patch: [
      '*** Begin Patch',
      `*** Update File: ${okPath}`,
      '@@',
      '-fine',
      '+changed',
      `*** Update File: ${resolve(root, 'missing.txt')}`,
      '@@',
      '-nope',
      '+never',
      '*** End Patch',
    ].join('\n'),
  }));

  assert.equal(output.ok, false);
  assert.equal(output.phase, 'parse');
  assert.equal(output.code, 'multiple_file_patches');
  assert.equal(readFileSync(okPath, 'utf-8'), 'fine\n');
});

test('apply_patch rejects malformed and non-V4A patches', async () => {
  const malformed = readJsonOutput(await applyPatchTool.invoke({
    patch: 'not a patch',
  }));
  assert.equal(malformed.ok, false);
  assert.equal(malformed.phase, 'parse');
  assert.equal(malformed.code, 'invalid_patch_syntax');

  const empty = readJsonOutput(await applyPatchTool.invoke({
    patch: '*** Begin Patch\n*** End Patch',
  }));
  assert.equal(empty.ok, false);
  assert.equal(empty.phase, 'parse');
  assert.equal(empty.code, 'invalid_patch_syntax');

  const mixed = readJsonOutput(await applyPatchTool.invoke({
    patch: [
      '*** Begin Patch',
      'diff --git a/file.txt b/file.txt',
      '--- a/file.txt',
      '+++ b/file.txt',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n'),
  }));
  assert.equal(mixed.ok, false);
  assert.equal(mixed.phase, 'parse');
  assert.equal(mixed.code, 'invalid_patch_syntax');

  const unified = readJsonOutput(await applyPatchTool.invoke({
    patch: [
      '--- a/file.txt',
      '+++ b/file.txt',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n'),
  }));
  assert.equal(unified.ok, false);
  assert.equal(unified.phase, 'parse');
  assert.equal(unified.code, 'invalid_patch_syntax');
  assert.throws(
    () => parsePatch('*** Begin Patch\n*** Update File: a.txt\n-old\n+new'),
    PatchParseError,
  );
});

test('parsePatch rejects Unified Diff', () => {
  assert.throws(
    () => parsePatch([
      '--- a/old.txt',
      '+++ b/new.txt',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n')),
    (error: unknown) => {
      assert.ok(error instanceof PatchParseError);
      assert.equal(error.details.phase, 'parse');
      return true;
    },
  );
});

test('V4A requires explicit changing hunks and strict envelope boundaries', () => {
  const invalidPatches = [
    [
      '*** Begin Patch',
      '*** Update File: src/app.ts',
      '-old',
      '+new',
      '*** End Patch',
    ],
    [
      '*** Begin Patch',
      '*** Update File: src/app.ts',
      '@@',
      ' unchanged',
      '*** End Patch',
    ],
    [
      'model preamble',
      '*** Begin Patch',
      '*** Update File: src/app.ts',
      '@@',
      '-old',
      '+new',
      '*** End Patch',
    ],
    [
      '*** Begin Patch',
      '*** Update File: src/app.ts',
      '@@',
      '-old',
      '+new',
      '*** End Patch',
      'model epilogue',
    ],
  ];

  for (const lines of invalidPatches) {
    assert.throws(
      () => parsePatch(lines.join('\n')),
      (error: unknown) => {
        assert.ok(error instanceof PatchParseError);
        assert.equal(error.details.phase, 'parse');
        return true;
      },
    );
  }
});

test('parsePatch parses anchors and end-of-file markers', () => {
  const update = parsePatch([
    '*** Begin Patch',
    '*** Update File: src/app.ts',
    '@@ function main()',
    ' context',
    '-old',
    '+new',
    '*** End of File',
    '*** End Patch',
  ].join('\n'));

  assert.equal(update.path, 'src/app.ts');
  assert.equal(update.chunks.length, 1);
  assert.equal(update.chunks[0]?.anchor, 'function main()');
  assert.deepEqual(update.chunks[0]?.oldLines, ['context', 'old']);
  assert.deepEqual(update.chunks[0]?.newLines, ['context', 'new']);
  assert.deepEqual(update.chunks[0]?.lines, [
    { kind: 'context', text: 'context' },
    { kind: 'removed', text: 'old' },
    { kind: 'added', text: 'new' },
  ]);
  assert.equal(update.chunks[0]?.isEndOfFile, true);
});

test('parsePatch keeps an explicitly prefixed empty context line', () => {
  const update = parsePatch([
    '*** Begin Patch',
    '*** Update File: src/app.ts',
    '@@',
    '-old',
    '+new',
    ' ',
    '*** End Patch',
  ].join('\n'));

  assert.deepEqual(update.chunks[0]?.oldLines, ['old', '']);
  assert.deepEqual(update.chunks[0]?.newLines, ['new', '']);
});

test('createBashToolkit registers review policies for file mutation tools', () => {
  const toolkit = createBashToolkit();

  assert.equal(Boolean(definition(toolkit, 'write_file')?.review), true);
  assert.equal(Boolean(definition(toolkit, 'apply_patch')?.review), true);
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
