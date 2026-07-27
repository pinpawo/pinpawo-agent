import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  ingestLocalPathPaste,
  parseLocalPathCandidates,
} from './localPathIngestion';

test('path parser accepts quoted, escaped, file URL, and multiple absolute paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-attachments-'));
  const first = join(root, 'first file.txt');
  const second = join(root, '第二.txt');
  await writeFile(first, 'first');
  await writeFile(second, 'second');

  assert.deepEqual(parseLocalPathCandidates(`'${first}' "${second}"`), [first, second]);
  assert.deepEqual(
    parseLocalPathCandidates(first.replaceAll(' ', '\\ ')),
    [first],
  );
  assert.deepEqual(
    parseLocalPathCandidates(pathToFileURL(second).href),
    [second],
  );
});

test('path ingestion validates readable files and directories without reading content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-attachments-'));
  const file = join(root, 'hello.txt');
  const directory = join(root, 'folder');
  await writeFile(file, 'hello');
  await mkdir(directory);
  const ids = ['attachment-1', 'attachment-2'];

  const result = ingestLocalPathPaste(`"${file}" "${directory}"`, {
    idFactory: () => ids.shift() ?? 'unexpected',
  });

  assert.deepEqual(result, {
    kind: 'attachments',
    duplicateCount: 0,
    attachments: [{
      id: 'attachment-1',
      source: 'local-path',
      kind: 'file',
      path: file,
      name: 'hello.txt',
    }, {
      id: 'attachment-2',
      source: 'local-path',
      kind: 'directory',
      path: directory,
      name: 'folder',
    }],
  });
});

test('path ingestion leaves prose and unavailable paths as composer text', () => {
  assert.deepEqual(ingestLocalPathPaste('please inspect /tmp/example'), {
    kind: 'text',
    pathLike: false,
  });
  const unavailable = ingestLocalPathPaste('/definitely/missing/pinpawo.txt');
  assert.equal(unavailable.kind, 'text');
  assert.equal(unavailable.pathLike, true);
  if (unavailable.kind === 'text' && unavailable.pathLike) {
    assert.match(unavailable.issue, /unavailable or unreadable/);
  }
});

test('path ingestion deduplicates current and pasted attachments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-attachments-'));
  const file = join(root, 'same.txt');
  await writeFile(file, 'same');

  assert.deepEqual(ingestLocalPathPaste(`"${file}" "${file}"`, {
    existingPaths: new Set([file]),
  }), {
    kind: 'attachments',
    attachments: [],
    duplicateCount: 1,
  });
});
