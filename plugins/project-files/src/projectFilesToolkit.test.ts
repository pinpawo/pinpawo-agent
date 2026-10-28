import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProjectFilesPlugin } from './projectFilesPlugin';
import { acquireLock } from './projectFilesService';

function findTool(plugin: ReturnType<typeof createProjectFilesPlugin>, name: string) {
  const definition = plugin.toolkits[0]?.tools.find((entry) => entry.tool.name === name);
  assert.ok(definition, `${name} is registered`);
  return definition;
}

test('project_files Toolkit reads and performs reviewed, digest-protected writes in the same knowledge root', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'pinpawo-project-toolkit-'));
  const root = path.join(parent, 'wiki');
  await mkdir(root);
  await writeFile(path.join(root, 'PROJECT.md'), '# Before\n');
  await writeFile(path.join(parent, 'outside.md'), 'private');
  await symlink(path.join(parent, 'outside.md'), path.join(root, 'outside.md'));
  const plugin = createProjectFilesPlugin({ rootDir: root, boundaryDir: root });
  const list = findTool(plugin, 'project_files_list');
  const read = findTool(plugin, 'project_files_read');
  const write = findTool(plugin, 'project_files_write');
  const listResult = JSON.parse(await list.tool.invoke({}) as string);
  assert.deepEqual(listResult.documents.map((item: { path: string }) => item.path), ['PROJECT.md']);
  const readResult = JSON.parse(await read.tool.invoke({ path: 'PROJECT.md' }) as string);
  assert.equal(readResult.document.content, '# Before\n');
  assert.match(readResult.document.digest, /^[a-f0-9]{64}$/);
  const input = { path: 'PROJECT.md', content: '# After\n', expectedDigest: readResult.document.digest };
  assert.ok(write.review?.authorization?.buildMatcher, 'write must require exact authorization');
  assert.equal(write.review?.canAutoApprove, undefined, 'write must not silently auto-approve');
  const review = await write.review?.request({
    toolkitName: 'project_files', toolName: 'project_files_write', input,
    operation: write.operation, reviewCapabilities: { humanReview: true, sessionAuthorization: true },
  });
  assert.ok(review && 'schemaVersion' in review && review.view.kind === 'operation');
  if (!review || !('schemaVersion' in review) || review.view.kind !== 'operation') throw new Error('Missing review');
  assert.equal(review.view.target, path.join(await realpath(root), 'PROJECT.md'));
  assert.ok(JSON.stringify(review.view.blocks).includes('# After'));
  assert.ok(review.options.some(({ id }) => id === 'approve'));
  const written = JSON.parse(await write.tool.invoke(input) as string);
  assert.equal(written.path, 'PROJECT.md');
  assert.equal(await readFile(path.join(root, 'PROJECT.md'), 'utf8'), '# After\n');
  assert.notEqual(written.digest, readResult.document.digest);
  await assert.rejects(write.tool.invoke({ ...input, content: 'old content' }), /changed since it was read/);
  assert.equal(await readFile(path.join(root, 'PROJECT.md'), 'utf8'), '# After\n');
  await write.tool.invoke({ path: 'guides/new.md', content: '# New\n', expectedDigest: null });
  assert.equal(await readFile(path.join(root, 'guides/new.md'), 'utf8'), '# New\n');
  await assert.rejects(write.tool.invoke({ path: 'guides/new.md', content: 'duplicate', expectedDigest: null }), /changed since it was read/);
  await assert.rejects(write.tool.invoke({ path: '../outside.md', content: 'bad', expectedDigest: null }), /normalized relative Markdown path/);
  await assert.rejects(write.tool.invoke({ path: '/tmp/outside.md', content: 'bad', expectedDigest: null }), /normalized relative Markdown path/);
  await assert.rejects(write.tool.invoke({ path: 'outside.md', content: 'bad', expectedDigest: null }), /symbolic links/);
  assert.equal(await readFile(path.join(parent, 'outside.md'), 'utf8'), 'private');
});

test('project_files serializes competing writers and preserves existing locks', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pinpawo-project-toolkit-lock-'));
  await writeFile(path.join(root, 'A.md'), 'initial');
  const first = createProjectFilesPlugin({ rootDir: root });
  const second = createProjectFilesPlugin({ rootDir: root });
  const read = findTool(first, 'project_files_read');
  const writeA = findTool(first, 'project_files_write');
  const writeB = findTool(second, 'project_files_write');
  const digest = JSON.parse(await read.tool.invoke({ path: 'A.md' }) as string).document.digest;
  const outcomes = await Promise.allSettled([
    writeA.tool.invoke({ path: 'A.md', content: 'first', expectedDigest: digest }),
    writeB.tool.invoke({ path: 'A.md', content: 'second', expectedDigest: digest }),
  ]);
  assert.equal(outcomes.filter(({ status }) => status === 'fulfilled').length, 1);
  const result = await readFile(path.join(root, 'A.md'), 'utf8');
  assert.ok(result === 'first' || result === 'second');

  const locks = path.join(await realpath(root), '.project-files-locks');
  const lockName = createHash('sha256').update(path.join(await realpath(root), 'A.md')).digest('hex') + '.lock';
  const stale = path.join(locks, lockName);
  await writeFile(stale, 'previous process lock', { flag: 'wx' });
  const currentDigest = JSON.parse(await read.tool.invoke({ path: 'A.md' }) as string).document.digest;
  await assert.rejects(writeA.tool.invoke({ path: 'A.md', content: 'third', expectedDigest: currentDigest }), /locked; inspect the PID and creation time/);
  assert.equal(await readFile(stale, 'utf8'), 'previous process lock');
  assert.equal(await readFile(path.join(root, 'A.md'), 'utf8'), result);
  await unlink(stale);
});

test('project_files rejects symlinks in write parents and switched knowledge roots', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'pinpawo-project-toolkit-symlink-'));
  const root = path.join(parent, 'root');
  const outside = path.join(parent, 'outside');
  const alias = path.join(parent, 'alias');
  await mkdir(root);
  await mkdir(outside);
  await symlink(outside, path.join(root, 'escape'));
  await symlink(root, alias);
  const plugin = createProjectFilesPlugin({ rootDir: alias });
  const write = findTool(plugin, 'project_files_write');
  await assert.rejects(write.tool.invoke({ path: 'escape/new.md', content: 'bad', expectedDigest: null }), /symbolic links/);
  await unlink(alias);
  await symlink(outside, alias);
  await assert.rejects(write.tool.invoke({ path: 'new.md', content: 'bad', expectedDigest: null }), /root changed after authorization/);
  await assert.rejects(findTool(plugin, 'project_files_list').tool.invoke({}), /root changed after authorization/);
  await assert.rejects(findTool(plugin, 'project_files_read').tool.invoke({ path: 'new.md' }), /root changed after authorization/);
});

test('exact write authorization includes the pinned knowledge root and strict path', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'pinpawo-project-toolkit-auth-'));
  const firstRoot = path.join(parent, 'one');
  const secondRoot = path.join(parent, 'two');
  await mkdir(firstRoot);
  await mkdir(secondRoot);
  await writeFile(path.join(firstRoot, 'A.md'), 'original');
  const first = findTool(createProjectFilesPlugin({ rootDir: firstRoot }), 'project_files_write');
  const second = findTool(createProjectFilesPlugin({ rootDir: secondRoot }), 'project_files_write');
  const input = { path: 'A.md', content: 'updated', expectedDigest: null };
  const authorization = (entry: typeof first) => entry.review?.authorization?.buildMatcher({
    toolkitName: 'project_files', toolName: 'project_files_write', input, operation: entry.operation,
  });
  const firstMatcher = await authorization(first);
  const secondMatcher = await authorization(second);
  const repeatedMatcher = await authorization(first);
  const modifiedMatcher = await first.review?.authorization?.buildMatcher({
    toolkitName: 'project_files', toolName: 'project_files_write',
    input: { ...input, content: 'different' }, operation: first.operation,
  });
  assert.equal(firstMatcher?.type, 'exact');
  assert.equal(secondMatcher?.type, 'exact');
  assert.equal(first.review?.authorization?.reuseAutoReview, true);
  assert.deepEqual(firstMatcher, repeatedMatcher, 'the same root and input can reuse exact authorization');
  assert.notDeepEqual(firstMatcher, secondMatcher, 'authorization cannot be reused across roots');
  assert.notDeepEqual(firstMatcher, modifiedMatcher, 'authorization cannot be reused for different content');
  const withWhitespace = { ...input, path: ' A.md ' };
  assert.equal(first.operation?.summarize?.(withWhitespace), null, 'invalid path has no misleading target');
  await assert.rejects(first.tool.invoke(withWhitespace), /normalized relative Markdown path/);
  assert.equal(await readFile(path.join(firstRoot, 'A.md'), 'utf8'), 'original');
});

test('different page creations are serialized and cannot exceed maxDocuments', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pinpawo-project-toolkit-count-'));
  await writeFile(path.join(root, 'A.md'), 'original');
  const first = createProjectFilesPlugin({ rootDir: root, maxDocuments: 2 });
  const second = createProjectFilesPlugin({ rootDir: root, maxDocuments: 2 });
  const outcomes = await Promise.allSettled([
    findTool(first, 'project_files_write').tool.invoke({ path: 'B.md', content: 'new b', expectedDigest: null }),
    findTool(second, 'project_files_write').tool.invoke({ path: 'C.md', content: 'new c', expectedDigest: null }),
  ]);
  assert.equal(outcomes.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal((await first.service.listDocuments()).length, 2);
  await assert.rejects(
    findTool(first, 'project_files_write').tool.invoke({ path: 'D.md', content: 'new d', expectedDigest: null }),
    /cannot create more than 2 Markdown documents/,
  );
  assert.equal((await first.service.listDocuments()).length, 2);
});

test('lock records process and creation time and never removes an existing lock automatically', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pinpawo-project-lock-diagnostic-'));
  const lockPath = path.join(root, 'existing.lock');
  const release = await acquireLock(lockPath);
  const lockData = JSON.parse(await readFile(lockPath, 'utf8')) as { pid: number; createdAt: string };
  assert.equal(lockData.pid, process.pid);
  assert.ok(Number.isFinite(Date.parse(lockData.createdAt)));
  await assert.rejects(acquireLock(lockPath), /inspect the PID and creation time.*remove that lock manually/);
  assert.deepEqual(JSON.parse(await readFile(lockPath, 'utf8')), lockData);
  await release();
  await assert.rejects(readFile(lockPath), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT');
});
