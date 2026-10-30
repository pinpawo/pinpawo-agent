import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectFilesService } from './projectFilesService';

test('temporary knowledge roots support list, read and authorized writes', async (t) => {
  // On Windows runners tmpdir() contains the RUNNER~1 short-name alias.
  const parent = await mkdtemp(path.join(tmpdir(), 'pinpawo-root-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'wiki');
  const service = new ProjectFilesService(root);
  assert.deepEqual(await service.listDocuments(), []);
  await mkdir(root);
  await writeFile(path.join(root, 'PROJECT.md'), '# Project\n');
  assert.equal(service.canonicalRoot, await realpath(root));
  assert.deepEqual((await service.listDocuments()).map(({ path }) => path), ['PROJECT.md']);
  assert.equal((await service.readDocument('PROJECT.md'))?.content, '# Project\n');
  await service.writeDocument('NEW.md', '# New\n', null, service.canonicalRoot);
  assert.equal((await service.readDocument('NEW.md'))?.content, '# New\n');
});

test('knowledge root junction or symlink replacement remains unauthorized', async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), 'pinpawo-root-swap-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const first = path.join(parent, 'first');
  const second = path.join(parent, 'second');
  const alias = path.join(parent, 'configured');
  await mkdir(first);
  await mkdir(second);
  await writeFile(path.join(second, 'PRIVATE.md'), '# Private\n');
  await symlink(first, alias, 'junction');
  const service = new ProjectFilesService(alias);
  assert.deepEqual(await service.listDocuments(), []);
  await rm(alias);
  await symlink(second, alias, 'junction');
  await assert.rejects(service.listDocuments(), /root changed after authorization/);
  await assert.rejects(service.readDocument('PRIVATE.md'), /root changed after authorization/);
  await assert.rejects(service.writeDocument('NEW.md', '# New\n', null), /root changed after authorization/);
});
