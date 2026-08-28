import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectFileTooLargeError, ProjectFilesService } from './projectFilesService';

test('Project Files lists and reads only Markdown under its configured root', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'pinpawo-project-files-'));
  const root = path.join(parent, 'wiki');
  await mkdir(path.join(root, 'guides'), { recursive: true });
  await Promise.all([
    writeFile(path.join(root, 'PROJECT.md'), '# Project\n'),
    writeFile(path.join(root, 'guides', 'START.md'), '# Start\n'),
    writeFile(path.join(root, 'private.txt'), 'not projected\n'),
    writeFile(path.join(parent, 'outside.md'), '# Outside\n'),
  ]);
  await symlink(path.join(parent, 'outside.md'), path.join(root, 'linked.md'));

  const service = new ProjectFilesService(root);
  const documents = await service.listDocuments();
  assert.deepEqual(documents.map(({ path: documentPath }) => documentPath), [
    'guides/START.md',
    'PROJECT.md',
  ]);
  assert.equal((await service.readDocument('PROJECT.md'))?.content, '# Project\n');
  assert.equal(await service.readDocument('missing.md'), null);
  await assert.rejects(service.readDocument('../outside.md'), /normalized relative Markdown path/);
  await assert.rejects(service.readDocument('linked.md'), /outside the configured root/);
});

test('Project Files bounds document size and count', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pinpawo-project-files-bounds-'));
  await Promise.all([
    writeFile(path.join(root, 'A.md'), '12345'),
    writeFile(path.join(root, 'B.md'), 'ok'),
  ]);

  const fileBound = new ProjectFilesService(root, { maxFileBytes: 4 });
  await assert.rejects(
    fileBound.readDocument('A.md'),
    (error: unknown) => error instanceof ProjectFileTooLargeError,
  );
  const countBound = new ProjectFilesService(root, { maxDocuments: 1 });
  await assert.rejects(countBound.listDocuments(), /more than 1 Markdown documents/);
});

test('Project Files treats an absent knowledge root as an empty collection', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'pinpawo-project-files-missing-'));
  const service = new ProjectFilesService(path.join(parent, 'wiki'));
  assert.deepEqual(await service.listDocuments(), []);
  assert.equal(await service.readDocument('PROJECT.md'), null);
});
