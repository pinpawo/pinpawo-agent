import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_ARTIFACT_BYTES } from '@pinpawo-toolkit/artifacts';
import { createLocalArtifactStore } from './localStore';
import { readArtifactSource, writeArtifactDownload } from './files';
import { createHostArtifactStore } from './index';
import { buildHostRuntimeConfig } from '../config/runtimeConfig';

const body = (text: string) => new ReadableStream<Uint8Array>({ start(controller) {
  controller.enqueue(new TextEncoder().encode(text)); controller.close();
} });

test('published snapshots survive source edits and shared references cross sessions and workspaces', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifact-test-'));
  try {
    const name = '报告 #100%?.md';
    const path = join(root, name);
    await writeFile(path, 'version one');
    const store = createLocalArtifactStore({ workspacesDir: root, workspaceId: 'workspace' });
    const source = await readArtifactSource({ path: name, workdir: root });
    const first = await store.put({ ...source, threadId: 'session', title: 'Report' });
    await writeFile(path, 'version two');
    const second = await store.put({ ...await readArtifactSource({ path, workdir: null }), threadId: 'session' });
    assert.notEqual(first.uri, second.uri);
    assert.equal(first.name, name);
    assert.equal(first.mimeType, 'text/markdown');
    const sharedStore = createLocalArtifactStore({ workspacesDir: root, workspaceId: 'different-workspace' });
    assert.deepEqual(await sharedStore.list('session'), []);
    assert.deepEqual((await store.list('session')).map(ref => ref.uri), [first.uri, second.uri]);
    assert.deepEqual(await store.list('other-session'), []);
    const fetched = await sharedStore.fetch(first.uri);
    assert.ok('body' in fetched);
    assert.equal(await new Response(fetched.body).text(), 'version one');
    const download = await store.fetch(first.uri);
    assert.ok('body' in download);
    const destination = await writeArtifactDownload({ threadId: 'receiver', path: 'download.md', workdir: root,
      ref: first, body: download.body });
    assert.equal(await readFile(destination, 'utf8'), 'version one');
    const temporary = await store.fetch(first.uri);
    assert.ok('body' in temporary);
    const temporaryPath = await writeArtifactDownload({ threadId: 'receiver', workdir: null,
      ref: first, body: temporary.body });
    try {
      assert.ok(temporaryPath.startsWith(join(tmpdir(), 'pinpawo-artifacts', 'receiver')));
      assert.equal(await readFile(temporaryPath, 'utf8'), 'version one');
    } finally { await rm(join(temporaryPath, '..'), { recursive: true, force: true }); }
    const corrupt = { ...first, sha256: 'bad' };
    await assert.rejects(writeArtifactDownload({ threadId: 'receiver', path: 'download.md', workdir: root,
      ref: corrupt, body: body('bad') }), /does not match/);
    assert.equal(await readFile(destination, 'utf8'), 'version one');
    assert.ok(!(await readdir(root)).some(entry => entry.startsWith('.artifact-download-')));
    await symlink(path, join(root, 'link.md'));
    await assert.rejects(readArtifactSource({ path: 'link.md', workdir: root }), /ordinary files/);
    await assert.rejects(store.fetch('artifact://workspace/session/%2e%2e/config'), /Invalid artifact/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('oversize and failed publications leave no visible or truncated artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifact-limit-'));
  try {
    const store = createLocalArtifactStore({ workspacesDir: root, workspaceId: 'workspace' });
    const oversized = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(MAX_ARTIFACT_BYTES + 1)); controller.close();
    } });
    await assert.rejects(store.put({ threadId: 'session', name: 'large.bin', mimeType: 'application/octet-stream', body: oversized }), /100 MB/);
    await assert.rejects(store.put({ threadId: 'session', name: 'failed.txt', mimeType: 'text/plain',
      body: new ReadableStream({ start(controller) { controller.error(new Error('source failed')); } }) }), /source failed/);
    assert.deepEqual(await store.list('session'), []);
    assert.deepEqual(await readdir(join(root, 'workspace', 'artifacts', 'session')), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Host chooses local by default and rejects incomplete COS global configuration', () => {
  const runtime = buildHostRuntimeConfig('/tmp/artifact-config');
  assert.ok(createHostArtifactStore(runtime, {}, {}));
  assert.throws(() => createHostArtifactStore(runtime, {}, { PINPAWO_ARTIFACT_STORE: 'cos' }), /require bucket/);
  assert.throws(() => createHostArtifactStore(runtime, {}, { PINPAWO_ARTIFACT_STORE: 'unknown' }), /local or cos/);
});

test('artifact references cannot follow storage symlinks outside the configured root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifact-safe-root-'));
  const outside = await mkdtemp(join(tmpdir(), 'artifact-outside-'));
  try {
    await mkdir(join(root, 'workspace', 'artifacts'), { recursive: true });
    await writeFile(join(outside, 'id.json'), '{}');
    await symlink(outside, join(root, 'workspace', 'artifacts', 'linked'));
    const store = createLocalArtifactStore({ workspacesDir: root, workspaceId: 'workspace' });
    await assert.rejects(store.fetch('artifact://workspace/linked/id/report.txt'), /escapes its storage root/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
