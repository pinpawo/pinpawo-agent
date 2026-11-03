import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { parseArtifactUri } from '@pinpawo/agent-contracts';
import { MAX_ARTIFACT_BYTES } from '@pinpawo-toolkit/artifacts';
import { FileArtifactStore } from './artifactStore';
import { readLocalArtifactSource } from './artifactSourceReader';

async function setup(t: TestContext, workspace = 'workspace') {
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-artifacts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: new FileArtifactStore(root, workspace) };
}

function body(content: Uint8Array | string) {
  const bytes = typeof content === 'string' ? Buffer.from(content) : content;
  return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}

function input(content: Uint8Array | string, threadId = 'thread-1', name = 'report.md') {
  return { threadId, name, mimeType: 'text/markdown', body: body(content) };
}

async function bytes(stream: ReadableStream<Uint8Array>) {
  return Buffer.from(await new Response(stream).arrayBuffer());
}

async function snapshotIsOpen(path: string) {
  if (process.platform !== 'linux') return false;
  const descriptors = await readdir('/proc/self/fd');
  const targets = await Promise.all(descriptors.map(fd => readlink(`/proc/self/fd/${fd}`).catch(() => '')));
  return targets.includes(path);
}

test('local artifacts retain path encoding while opaque session IDs cannot escape storage', async t => {
  const { root, store } = await setup(t);
  const ref = await store.put(input('contained', '../thread/with space', 'report name.md'));
  const parts = parseArtifactUri(ref.uri).key.split('/');
  assert.equal(parts[1], Buffer.from('../thread/with space').toString('base64url'));
  assert.equal(parts[3], 'report%20name%2Emd');
  assert.equal((await store.list('../thread/with space')).length, 1);
  assert.equal((await bytes((await store.fetch(ref.uri)).body)).toString(), 'contained');
  assert.equal(await readFile(join(root, parts[0]!, 'artifacts', parts[1]!, parts[2]!, parts[3]!), 'utf8'), 'contained');
  await assert.rejects(store.put(input('bad', 'thread-1', '../outside')), /single file name/);
  await assert.rejects(store.fetch('artifact://workspace/%2E%2E/id/name'), TypeError);
  await assert.rejects(store.fetch('artifact://workspace/thread/id/%2Foutside'), TypeError);
});

test('published files are snapshots and repeated publications get distinct references', async t => {
  const { root, store } = await setup(t);
  const sourcePath = join(root, 'source.md');
  await writeFile(sourcePath, 'first');
  const firstSource = await readLocalArtifactSource({ path: sourcePath, workdir: null });
  const first = await store.put({ threadId: 'thread-1', ...firstSource });
  const secondSource = await readLocalArtifactSource({ path: sourcePath, workdir: null });
  const second = await store.put({ threadId: 'thread-1', ...secondSource });
  assert.notEqual(first.uri, second.uri);
  assert.equal(first.sha256, second.sha256);
  await writeFile(sourcePath, 'changed');
  await rm(sourcePath);
  assert.equal((await bytes((await store.fetch(first.uri)).body)).toString(), 'first');
  assert.equal((await store.list('thread-1')).length, 2);
});

test('local artifacts preserve complete binary and empty files with hashes', async t => {
  const { store } = await setup(t);
  for (const content of [Buffer.from([0, 255, 137, 80]), Buffer.alloc(0)]) {
    const ref = await store.put({ ...input(content, 'thread-1', 'image.png'), mimeType: 'image/png' });
    assert.equal(ref.size, content.length);
    assert.equal(ref.sha256, createHash('sha256').update(content).digest('hex'));
    assert.deepEqual(await bytes((await store.fetch(ref.uri)).body), content);
  }
});

test('metadata sidecars do not collide with published file names', async t => {
  const { store } = await setup(t);
  for (const name of ['ref.json', '.metadata']) {
    const ref = await store.put(input('content', 'thread-1', name));
    assert.equal((await bytes((await store.fetch(ref.uri)).body)).toString(), 'content');
  }
  assert.equal((await store.list('thread-1')).length, 2);
});

test('a valid but different object name is not found in either fetch or address resolution', async t => {
  const { store } = await setup(t);
  const ref = await store.put(input('snapshot'));
  const missing = ref.uri.replace(/\/[^/]+$/, '/missing%2Etxt');
  await assert.rejects(store.fetch(missing), { code: 'ENOENT' });
  await assert.rejects(store.resolvePath(missing), { code: 'ENOENT' });
});

test('listing stays in the session while received references work across sessions and workspaces', async t => {
  const { root, store } = await setup(t, 'writer-workspace');
  const other = new FileArtifactStore(root, 'reader-workspace');
  assert.deepEqual(await store.list('empty'), []);
  const own = await store.put(input('own', 'writer'));
  await store.put(input('other-session', 'second-writer'));
  const readerRef = await other.put(input('reader-own', 'reader'));
  assert.deepEqual((await store.list('writer')).map(ref => ref.uri), [own.uri]);
  assert.deepEqual((await other.list('reader')).map(ref => ref.uri), [readerRef.uri]);
  assert.deepEqual(await other.list('writer'), []);
  assert.equal((await bytes((await other.fetch(own.uri)).body)).toString(), 'own');
});

test('resolving a received reference returns the existing cross-workspace snapshot without writes or open descriptors', async t => {
  const { root, store } = await setup(t, 'writer-workspace');
  const reader = new FileArtifactStore(root, 'reader-workspace');
  const ref = await store.put(input('published snapshot', 'writer/session', 'report name.md'));
  const existingPaths = (await readdir(root, { recursive: true })).sort();
  const [workspace, thread, id, name] = parseArtifactUri(ref.uri).key.split('/');
  const expected = join(await realpath(root), workspace!, 'artifacts', thread!, id!, name!);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal(await reader.resolvePath(ref.uri), expected);
    assert.equal(await snapshotIsOpen(expected), false);
  }
  assert.equal(await readFile(expected, 'utf8'), 'published snapshot');
  assert.deepEqual((await readdir(root, { recursive: true })).sort(), existingPaths);
  assert.deepEqual(await reader.list('writer/session'), []);
});

test('local path resolution validates URI, existence and regular-file size', async t => {
  const { store } = await setup(t);
  await assert.rejects(store.resolvePath('https://example.test/file'), TypeError);
  await assert.rejects(store.resolvePath('artifact://workspace/%2E%2E/id/name'), TypeError);
  await assert.rejects(store.resolvePath('artifact://workspace/thread/missing/name'), { code: 'ENOENT' });
  const ref = await store.put(input('safe'));
  const path = await store.resolvePath(ref.uri);
  await writeFile(path, 'changed size');
  await assert.rejects(store.resolvePath(ref.uri), /stored file metadata/);
  await assert.rejects(store.fetch(ref.uri), /stored file metadata/);
  assert.equal(await snapshotIsOpen(path), false);
  await rm(path);
  await assert.rejects(store.resolvePath(ref.uri), { code: 'ENOENT' });
});

test('a failed new publication does not expose partial bytes or change earlier snapshots', async t => {
  const { root, store } = await setup(t);
  const previous = await store.put(input('safe'));
  let sent = false;
  const failed = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) { sent = true; controller.enqueue(Buffer.from('partial')); }
      else controller.error(new Error('source failed'));
    },
  });
  await assert.rejects(store.put({ ...input('unused'), body: failed }), /source failed/);
  assert.deepEqual((await store.list('thread-1')).map(ref => ref.uri), [previous.uri]);
  assert.equal((await bytes((await store.fetch(previous.uri)).body)).toString(), 'safe');
  const paths = await readdir(root, { recursive: true });
  assert.equal(paths.some(path => path.endsWith('.publishing') || path.endsWith('.tmp')), false);
  const threadRoot = join(root, 'workspace', 'artifacts', Buffer.from('thread-1').toString('base64url'));
  assert.equal((await readdir(threadRoot)).filter(name => name !== '.metadata').length, 1);
});

test('a rejected storage path cancels the unconsumed source and preserves unrelated files', async t => {
  const { root, store } = await setup(t);
  const destination = join(root, 'workspace', 'artifacts');
  await mkdir(join(root, 'outside'));
  await writeFile(join(root, 'outside', 'keep.txt'), 'safe');
  await mkdir(join(root, 'workspace'));
  await symlink(join(root, 'outside'), destination, 'dir');
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  await assert.rejects(store.put({ ...input('unused'), body: stream }), /outside its object path/);
  assert.equal(cancelled, true);
  assert.equal(await readFile(join(root, 'outside', 'keep.txt'), 'utf8'), 'safe');
  assert.deepEqual(await readdir(join(root, 'outside')), ['keep.txt']);
});

test('fetch rejects symlink content and distinguishes invalid URI from missing objects', async t => {
  const { root, store } = await setup(t);
  const ref = await store.put(input('safe'));
  const [workspace, thread, id, name] = parseArtifactUri(ref.uri).key.split('/');
  const path = join(root, workspace!, 'artifacts', thread!, id!, name!);
  await rm(path);
  await writeFile(join(root, 'outside.txt'), 'outside');
  await symlink(join(root, 'outside.txt'), path);
  await assert.rejects(store.fetch(ref.uri), /regular file within/);
  await assert.rejects(store.resolvePath(ref.uri), /regular file within/);
  await assert.rejects(store.fetch('https://example.test/file'), TypeError);
  await assert.rejects(store.fetch('artifact://workspace/thread/missing/name'), { code: 'ENOENT' });
});

test('the 100 MB limit is streamed, exact at the boundary, and cancels an oversized source', async t => {
  const { root, store } = await setup(t);
  const chunk = Buffer.alloc(1_000_000, 97);
  let remaining = MAX_ARTIFACT_BYTES / chunk.length;
  const exact = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (remaining-- > 0) controller.enqueue(chunk);
      else controller.close();
    },
  });
  const ref = await store.put({ ...input('unused'), body: exact });
  assert.equal(ref.size, MAX_ARTIFACT_BYTES);
  const opened = await store.fetch(ref.uri);
  await opened.body.cancel();
  let cancelled = false;
  const oversized = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(chunk); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(store.put({ ...input('unused'), body: oversized }), /100 MB/);
  assert.equal(cancelled, true);
  assert.deepEqual((await store.list('thread-1')).map(item => item.uri), [ref.uri]);
  assert.equal((await readdir(root, { recursive: true })).some(path => path.endsWith('.publishing')), false);
});
