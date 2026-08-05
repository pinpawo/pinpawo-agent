import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { AgentToolkit } from '@pinpawo/pet-agent';
import { createBashToolkit } from './toolkits/local';
import {
  applyPatchTool as rawApplyPatchTool,
  copyPathTool,
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
  parsePatchDocument,
  PatchParseError,
  type PatchFormat,
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

const applyPatchTool = {
  invoke(input: { patch: string; format?: PatchFormat }) {
    const format = input.format
      ?? (input.patch.includes('*** Begin Patch') ? 'v4a' : 'unified');
    return rawApplyPatchTool.invoke({ ...input, format });
  },
};

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
  const authorizationMatcher = await policy.authorization?.buildMatcher(context);

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
    format: 'v4a',
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
  const view = review && 'schemaVersion' in review ? review.view : null;
  assert.ok(view && view.kind === 'diff');
  assert.equal(view.title, '应用补丁');
  assert.match(view.patch, /\*\*\* Update File/);
  assert.match(view.target ?? '', new RegExp(filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('bash toolkit reviews Unified Diff apply_patch with resolved file paths', async (t) => {
  const root = createFileFixture(t);
  const filePath = resolve(root, 'note.txt');
  const input = {
    format: 'unified',
    patch: [
      `--- ${filePath}`,
      `+++ ${filePath}`,
      '@@ -1 +1 @@',
      '-before',
      '+after',
    ].join('\n'),
  };
  const policy = reviewPolicyFor('apply_patch');

  const review = await policy.request(reviewContext('apply_patch', input));
  const view = review && 'schemaVersion' in review ? review.view : null;
  assert.ok(view && view.kind === 'diff');
  assert.equal(view.title, '应用补丁');
  assert.match(view.patch, /^--- /);
  assert.match(view.target ?? '', new RegExp(filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('bash toolkit reviews local path mutations with presets', () => {
  const toolkit = createBashToolkit();

  assert.equal(Boolean(definition(toolkit, 'move_path')?.review), true);
  assert.equal(Boolean(definition(toolkit, 'copy_path')?.review), true);
  assert.equal(Boolean(definition(toolkit, 'mkdir_path')?.review), true);
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
      ' alpha',
      '-beta',
      '+BETA',
      ' gamma',
      '*** End Patch',
    ].join('\n'),
  }));

  assert.equal(result.ok, true);
  assert.equal(result.format, 'v4a');
  assert.deepEqual(result.files, [{ path: filePath, type: 'update', chunks: 1 }]);
  assert.equal(readFileSync(filePath, 'utf-8'), 'alpha\nBETA\ngamma\ndelta\n');
});

test('apply_patch accepts Unified Diff and locates hunks by context instead of line offsets', async (t) => {
  const root = createFileFixture(t);
  const filePath = resolve(root, 'note.txt');
  writeFileSync(filePath, 'alpha\nbeta\ngamma\ndelta\n', 'utf-8');

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

  assert.equal(result.ok, true);
  assert.equal(result.format, 'unified');
  assert.deepEqual(result.files, [{ path: filePath, type: 'update', chunks: 1 }]);
  assert.equal(readFileSync(filePath, 'utf-8'), 'alpha\nBETA\ngamma\ndelta\n');
});

test('apply_patch preserves CRLF while tolerating trailing-whitespace drift in Unified Diff', async (t) => {
  const root = createFileFixture(t);
  const filePath = resolve(root, 'windows.txt');
  writeFileSync(filePath, 'alpha   \r\nbeta\r\ngamma\r\n', 'utf-8');

  const result = readJsonOutput(await applyPatchTool.invoke({
    patch: [
      `--- ${filePath}`,
      `+++ ${filePath}`,
      '@@ -1,3 +1,3 @@',
      ' alpha',
      '-beta',
      '+BETA',
      ' gamma',
    ].join('\n'),
  }));

  assert.equal(result.ok, true);
  assert.equal(readFileSync(filePath, 'utf-8'), 'alpha   \r\nBETA\r\ngamma\r\n');
});

test('apply_patch does not ignore leading indentation in Unified Diff context', async (t) => {
  const root = createFileFixture(t);
  const filePath = resolve(root, 'indent.py');
  const original = 'def run():\n    return 1\n';
  writeFileSync(filePath, original, 'utf-8');

  const result = readJsonOutput(await applyPatchTool.invoke({
    patch: [
      `--- ${filePath}`,
      `+++ ${filePath}`,
      '@@ -1,2 +1,2 @@',
      ' def run():',
      '-  return 1',
      '+  return 2',
    ].join('\n'),
  }));

  assert.equal(result.ok, false);
  assert.equal(result.code, 'context_not_found');
  assert.equal(readFileSync(filePath, 'utf-8'), original);
});

test('apply_patch accepts Unified Diff add and delete operations', async (t) => {
  const root = createFileFixture(t);
  const addedPath = resolve(root, 'added.txt');
  const deletedPath = resolve(root, 'deleted.txt');
  writeFileSync(deletedPath, 'obsolete\n', 'utf-8');

  const result = readJsonOutput(await applyPatchTool.invoke({
    patch: [
      'diff --git a/added.txt b/added.txt',
      'new file mode 100644',
      '--- /dev/null',
      `+++ ${addedPath}`,
      '@@ -0,0 +1,2 @@',
      '+hello',
      '+world',
      'diff --git a/deleted.txt b/deleted.txt',
      'deleted file mode 100644',
      `--- ${deletedPath}`,
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-obsolete',
    ].join('\n'),
  }));

  assert.equal(result.ok, true);
  assert.equal(result.format, 'unified');
  assert.equal(readFileSync(addedPath, 'utf-8'), 'hello\nworld\n');
  assert.equal(existsSync(deletedPath), false);
});

test('apply_patch treats --- and +++ hunk lines as content instead of file headers', async (t) => {
  const root = createFileFixture(t);
  const filePath = resolve(root, 'markers.txt');
  writeFileSync(filePath, 'before\n-- a/example\nafter\n', 'utf-8');

  const result = readJsonOutput(await applyPatchTool.invoke({
    patch: [
      `--- ${filePath}`,
      `+++ ${filePath}`,
      '@@ -1,3 +1,3 @@',
      ' before',
      '--- a/example',
      '+++ b/example',
      ' after',
    ].join('\n'),
  }));

  assert.equal(result.ok, true);
  assert.equal(readFileSync(filePath, 'utf-8'), 'before\n++ b/example\nafter\n');
});

test('apply_patch does not mistake a V4A marker inside Unified Diff content for its envelope', async (t) => {
  const root = createFileFixture(t);
  const filePath = resolve(root, 'protocol.txt');
  writeFileSync(filePath, 'before\n*** Begin Patch\nafter\n', 'utf-8');

  const result = readJsonOutput(await applyPatchTool.invoke({
    format: 'unified',
    patch: [
      `--- ${filePath}`,
      `+++ ${filePath}`,
      '@@ -1,3 +1,3 @@',
      ' before',
      '-*** Begin Patch',
      '+ordinary content',
      ' after',
    ].join('\n'),
  }));

  assert.equal(result.ok, true);
  assert.equal(result.format, 'unified');
  assert.equal(readFileSync(filePath, 'utf-8'), 'before\nordinary content\nafter\n');
});

test('apply_patch rejects ambiguous Unified Diff context without modifying the file', async (t) => {
  const root = createFileFixture(t);
  const filePath = resolve(root, 'repeated.txt');
  const original = 'alpha\nbeta\ngamma\nalpha\nbeta\ngamma\n';
  writeFileSync(filePath, original, 'utf-8');

  const result = readJsonOutput(await applyPatchTool.invoke({
    patch: [
      `--- ${filePath}`,
      `+++ ${filePath}`,
      '@@ -1,3 +1,3 @@',
      ' alpha',
      '-beta',
      '+BETA',
      ' gamma',
    ].join('\n'),
  }));

  assert.equal(result.ok, false);
  assert.equal(result.format, 'unified');
  assert.equal(result.phase, 'match');
  assert.equal(result.code, 'ambiguous_context');
  assert.deepEqual(result.matches, [1, 4]);
  assert.equal(readFileSync(filePath, 'utf-8'), original);
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
  const files = result.files as Array<Record<string, unknown>>;
  assert.equal(files[0]?.fuzz, 'ignore-whitespace');
  assert.equal(readFileSync(filePath, 'utf-8'), [
    '@dataclass(frozen=True)',
    'class AppConfig:',
    '    profile: str = "dev"',
    '    region_id: str',
    '    product: str',
    '',
  ].join('\n'));
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

test('apply_patch reports structured missing context with closest-match hint', async (t) => {
  const root = createFileFixture(t);
  const filePath = resolve(root, 'note.txt');
  writeFileSync(filePath, 'alpha\nbeta variant\ngamma\n', 'utf-8');

  const output = readJsonOutput(await applyPatchTool.invoke({
    patch: [
      '*** Begin Patch',
      `*** Update File: ${filePath}`,
      '-beta original',
      '+BETA',
      '*** End Patch',
    ].join('\n'),
  }));

  assert.equal(output.ok, false);
  assert.equal(output.format, 'v4a');
  assert.equal(output.phase, 'match');
  assert.equal(output.code, 'context_not_found');
  assert.equal(output.hunk, 1);
  assert.match(JSON.stringify(output.closest), /beta variant/);
  assert.equal(readFileSync(filePath, 'utf-8'), 'alpha\nbeta variant\ngamma\n');
});

test('apply_patch validates every file before touching any', async (t) => {
  const root = createFileFixture(t);
  const okPath = resolve(root, 'ok.txt');
  writeFileSync(okPath, 'fine\n', 'utf-8');

  const output = readJsonOutput(await applyPatchTool.invoke({
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

  assert.equal(output.ok, false);
  assert.equal(output.format, 'v4a');
  assert.equal(output.phase, 'match');
  assert.equal(output.code, 'target_not_found');
  assert.equal(readFileSync(okPath, 'utf-8'), 'fine\n');
});

test('apply_patch preflights every Unified Diff file before writing', async (t) => {
  const root = createFileFixture(t);
  const okPath = resolve(root, 'ok.txt');
  const missingPath = resolve(root, 'missing.txt');
  writeFileSync(okPath, 'fine\n', 'utf-8');

  const output = readJsonOutput(await applyPatchTool.invoke({
    patch: [
      `diff --git a/${okPath} b/${okPath}`,
      `--- ${okPath}`,
      `+++ ${okPath}`,
      '@@ -1 +1 @@',
      '-fine',
      '+changed',
      `diff --git a/${missingPath} b/${missingPath}`,
      `--- ${missingPath}`,
      `+++ ${missingPath}`,
      '@@ -1 +1 @@',
      '-missing',
      '+changed',
    ].join('\n'),
  }));

  assert.equal(output.ok, false);
  assert.equal(output.format, 'unified');
  assert.equal(output.code, 'target_not_found');
  assert.equal(readFileSync(okPath, 'utf-8'), 'fine\n');
});

test('apply_patch requires an explicit patch format', async () => {
  await assert.rejects(
    () => rawApplyPatchTool.invoke({ patch: '*** Begin Patch\n*** End Patch' } as never),
    /format/i,
  );
});

test('apply_patch rejects malformed patches and declared format mismatches', async () => {
  const malformed = readJsonOutput(await applyPatchTool.invoke({
    format: 'v4a',
    patch: 'not a patch',
  }));
  assert.equal(malformed.ok, false);
  assert.equal(malformed.format, 'v4a');
  assert.equal(malformed.phase, 'parse');
  assert.equal(malformed.code, 'invalid_patch_syntax');

  const empty = readJsonOutput(await applyPatchTool.invoke({
    patch: '*** Begin Patch\n*** End Patch',
  }));
  assert.equal(empty.ok, false);
  assert.equal(empty.format, 'v4a');
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
  assert.equal(mixed.format, 'v4a');
  assert.equal(mixed.phase, 'parse');
  assert.equal(mixed.code, 'invalid_patch_syntax');

  const mismatch = readJsonOutput(await applyPatchTool.invoke({
    format: 'unified',
    patch: [
      '*** Begin Patch',
      '*** Update File: file.txt',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n'),
  }));
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.phase, 'detect');
  assert.equal(mismatch.code, 'patch_format_mismatch');
  assert.equal(mismatch.declaredFormat, 'unified');
  assert.equal(mismatch.detectedFormat, 'v4a');
  assert.throws(
    () => parsePatch('*** Begin Patch\n*** Update File: a.txt\n-old\n+new'),
    PatchParseError,
  );
});

test('parsePatchDocument rejects Unified Diff rename syntax and reports the protocol', () => {
  assert.throws(
    () => parsePatchDocument([
      '--- a/old.txt',
      '+++ b/new.txt',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n')),
    (error: unknown) => {
      assert.ok(error instanceof PatchParseError);
      assert.equal(error.details.format, 'unified');
      assert.equal(error.details.phase, 'parse');
      return true;
    },
  );
});

test('parsePatchDocument rejects a Unified Diff hunk that contains only context', () => {
  assert.throws(
    () => parsePatchDocument([
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1 +1 @@',
      ' unchanged',
    ].join('\n')),
    (error: unknown) => {
      assert.ok(error instanceof PatchParseError);
      assert.equal(error.details.format, 'unified');
      assert.equal(error.details.phase, 'parse');
      assert.match(error.message, /contains no changes/);
      return true;
    },
  );
});

test('V4A and Unified Diff normalize equivalent updates to the same operations', () => {
  const v4a = parsePatchDocument([
    '*** Begin Patch',
    '*** Update File: src/app.ts',
    ' before',
    '-old',
    '+new',
    ' after',
    '*** End Patch',
  ].join('\n'));
  const unified = parsePatchDocument([
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -1,3 +1,3 @@',
    ' before',
    '-old',
    '+new',
    ' after',
  ].join('\n'));

  assert.deepEqual(unified.operations, v4a.operations);
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
  assert.deepEqual(update.chunks[0]?.lines, [
    { kind: 'context', text: 'context' },
    { kind: 'removed', text: 'old' },
    { kind: 'added', text: 'new' },
  ]);
  assert.equal(update.chunks[0]?.isEndOfFile, true);
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
