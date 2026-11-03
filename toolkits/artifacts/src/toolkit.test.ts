import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { isToolMessage } from '@langchain/core/messages';
import type { ArtifactRef } from '@pinpawo/agent-contracts';
import { createArtifactsToolkit } from './toolkit';
import type { ArtifactSourceReader, ArtifactStore } from './types';

function stream(content: string | Uint8Array) {
  const bytes = typeof content === 'string' ? Buffer.from(content) : content;
  return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}

function reference(content = 'bytes', name = 'file.bin'): ArtifactRef {
  return {
    uri: `artifact://workspace/session/${randomUUID()}/file.bin`, name,
    mimeType: 'application/octet-stream', size: Buffer.byteLength(content),
    sha256: createHash('sha256').update(content).digest('hex'), createdAt: new Date().toISOString(),
  };
}

function invocation(threadId = 'thread-1', workdir = '/tmp/test-workdir') {
  return { context: { executionScope: { threadId, workdir, taskId: 'task', runId: 'run', delegationId: 'delegation' } } };
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-artifact-toolkit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, tempRoot: join(root, 'managed'), workdir: join(root, 'workdir') };
}

function unusedSource(): ReturnType<ArtifactSourceReader> { throw new Error('Unexpected source read.'); }

function downloadFixture(content = 'bytes', override?: Partial<ArtifactRef>) {
  const ref = { ...reference(content), ...override };
  const store: ArtifactStore = {
    put: async () => { throw new Error('Unexpected publish.'); }, list: async () => [],
    fetch: async () => ({ ref, body: stream(content) }),
  };
  return { store, ref };
}

function definition(toolkit: ReturnType<typeof createArtifactsToolkit>, name: string) {
  const result = toolkit.tools.find(item => item.tool.name === name);
  assert.ok(result);
  return result;
}

test('publish declares a real tool artifact and list uses only the invocation session', async t => {
  const { tempRoot, workdir } = await fixture(t);
  const records: { threadId: string; ref: ArtifactRef }[] = [];
  const reads: { path: string; workdir: string | null }[] = [];
  const store: ArtifactStore = {
    put: async input => {
      const content = await new Response(input.body).text();
      const ref = { ...reference(content, input.name), ...(input.title ? { title: input.title } : {}) };
      records.push({ threadId: input.threadId, ref });
      return ref;
    },
    list: async threadId => records.filter(item => item.threadId === threadId).map(item => item.ref),
    fetch: async () => { throw new Error('Unexpected fetch.'); },
  };
  const toolkit = createArtifactsToolkit({ store, tempRoot, sourceReader: async input => {
    reads.push(input); return { name: 'report.md', mimeType: 'text/markdown', body: stream('# Report') };
  } });
  const published = await definition(toolkit, 'publish_artifact').tool.invoke({
    type: 'tool_call', id: 'publish-call', name: 'publish_artifact', args: { path: 'report.md', title: 'Report' },
  }, invocation('writer', workdir));
  assert.ok(isToolMessage(published));
  assert.deepEqual(published.artifact, { deliverables: [{ uri: records[0]!.ref.uri, title: 'Report' }] });
  assert.deepEqual(reads, [{ path: 'report.md', workdir }]);
  assert.equal(records[0]!.threadId, 'writer');
  const list = definition(toolkit, 'list_artifacts').tool;
  assert.equal(JSON.parse(String(await list.invoke({}, invocation('writer')))).length, 1);
  assert.deepEqual(JSON.parse(String(await list.invoke({}, invocation('other')))), []);
  await assert.rejects(list.invoke({ threadId: 'writer' }, invocation('other')));
  await assert.rejects(definition(toolkit, 'publish_artifact').tool.invoke({ path: 'report.md', threadId: 'other' }, invocation()));
});

test('artifact tools reject missing session scope before touching ports', async t => {
  const { tempRoot } = await fixture(t);
  const toolkit = createArtifactsToolkit({ tempRoot, sourceReader: unusedSource, store: {
    put: async () => { throw new Error('Unexpected publish.'); },
    list: async () => { throw new Error('Unexpected list.'); },
    fetch: async () => { throw new Error('Unexpected fetch.'); },
  } });
  await assert.rejects(definition(toolkit, 'publish_artifact').tool.invoke({ path: 'file' }), /Agent session/);
  await assert.rejects(definition(toolkit, 'list_artifacts').tool.invoke({}), /Agent session/);
  await assert.rejects(definition(toolkit, 'download_artifact').tool.invoke({ uri: reference().uri }), /Agent session/);
});

test('default downloads use the current session temporary directory without write review', async t => {
  const { tempRoot, workdir } = await fixture(t);
  const { store, ref } = downloadFixture();
  const item = definition(createArtifactsToolkit({ store, sourceReader: unusedSource, tempRoot }), 'download_artifact');
  const policy = { toolkitName: 'artifacts', toolName: item.tool.name, reviewCapabilities: { humanReview: true, sessionAuthorization: true } };
  assert.equal(await item.review?.request({ ...policy, input: { uri: ref.uri } }), null);
  const result = JSON.parse(String(await item.tool.invoke({ uri: ref.uri }, invocation('receiver', workdir))));
  assert.equal(result.uri, ref.uri);
  assert.ok(result.path.startsWith(join(tempRoot, Buffer.from('receiver').toString('base64url'))));
  assert.equal(await readFile(result.path, 'utf8'), 'bytes');
  const explicit = join(workdir, 'received.bin');
  const reviewed = await item.review?.request({ ...policy, input: { uri: ref.uri, path: explicit } });
  assert.ok(reviewed && !('type' in reviewed && reviewed.type === 'block'));
  const matcher = await item.review?.authorization?.buildMatcher({ toolkitName: 'artifacts', toolName: item.tool.name, input: { uri: ref.uri, path: explicit } });
  assert.equal(matcher?.type, 'exact');
  const written = JSON.parse(String(await item.tool.invoke({ uri: ref.uri, path: 'received.bin' }, invocation('receiver', workdir))));
  assert.equal(written.path, explicit);
  assert.equal(await readFile(explicit, 'utf8'), 'bytes');
});

test('managed temporary writes stay in this session and cannot follow a symlink into workdir', async t => {
  const { root, tempRoot, workdir } = await fixture(t);
  const { store, ref } = downloadFixture();
  const item = definition(createArtifactsToolkit({ store, sourceReader: unusedSource, tempRoot }), 'download_artifact');
  const ownDirectory = join(tempRoot, Buffer.from('receiver').toString('base64url'));
  const ownPath = join(ownDirectory, 'file.bin');
  assert.equal(await item.review?.request({ toolkitName: 'artifacts', toolName: item.tool.name, input: { uri: ref.uri, path: ownPath } }), null);
  await item.tool.invoke({ uri: ref.uri, path: ownPath }, invocation('receiver', workdir));
  assert.equal(await readFile(ownPath, 'utf8'), 'bytes');
  const otherPath = join(tempRoot, Buffer.from('other').toString('base64url'), 'file.bin');
  await assert.rejects(item.tool.invoke({ uri: ref.uri, path: otherPath }, invocation('receiver', workdir)), /current Agent session/);
  await mkdir(workdir);
  await writeFile(join(workdir, 'keep'), 'safe');
  await symlink(workdir, join(ownDirectory, 'linked'), 'dir');
  await assert.rejects(item.tool.invoke({ uri: ref.uri, path: join(ownDirectory, 'linked', 'new-dir', 'file.bin') }, invocation('receiver', workdir)), /outside its session/);
  assert.deepEqual(await readdir(workdir), ['keep']);
  assert.ok((await readdir(root)).includes('managed'));
});

test('tampered metadata names are rejected and their opened streams are canceled', async t => {
  const { tempRoot, root } = await fixture(t);
  const { store, ref } = downloadFixture('bytes', { name: '../escape.bin' });
  let cancelled = false;
  store.fetch = async () => ({ ref, body: new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }) });
  const tool = definition(createArtifactsToolkit({ store, sourceReader: unusedSource, tempRoot }), 'download_artifact').tool;
  await assert.rejects(tool.invoke({ uri: ref.uri }, invocation()), /single file name/);
  assert.equal(cancelled, true);
  assert.deepEqual(await readdir(root), []);
});

test('download failures preserve existing target bytes and remove incomplete temporary files', async t => {
  const { workdir, tempRoot } = await fixture(t);
  await mkdir(workdir);
  const target = join(workdir, 'file.bin');
  await writeFile(target, 'existing');
  const { store, ref } = downloadFixture('bytes');
  store.fetch = async () => ({ ref, body: stream('wrong') });
  const tool = definition(createArtifactsToolkit({ store, sourceReader: unusedSource, tempRoot }), 'download_artifact').tool;
  await assert.rejects(tool.invoke({ uri: ref.uri, path: target }, invocation('receiver', workdir)), /stored size and hash/);
  assert.equal(await readFile(target, 'utf8'), 'existing');
  assert.deepEqual(await readdir(workdir), ['file.bin']);
});

test('signed download URLs are used for this fetch and never returned in tool content', async t => {
  const { tempRoot } = await fixture(t);
  const { store, ref } = downloadFixture();
  const url = 'https://objects.example.test/file?temporary-signature=not-a-secret';
  store.fetch = async () => ({ ref, url, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const fetched: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (input: unknown) => { fetched.push(input); return new Response('bytes'); });
  const tool = definition(createArtifactsToolkit({ store, sourceReader: unusedSource, tempRoot }), 'download_artifact').tool;
  const result = String(await tool.invoke({ uri: ref.uri }, invocation()));
  assert.deepEqual(fetched, [url]);
  assert.equal(result.includes('temporary-signature'), false);
  assert.equal(await readFile(JSON.parse(result).path, 'utf8'), 'bytes');
});

test('publish cancellation propagates to the file stream without returning a delivery declaration', async t => {
  const { tempRoot } = await fixture(t);
  const controller = new AbortController();
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({
    pull(streamController) { streamController.enqueue(Buffer.from('chunk')); },
    cancel() { cancelled = true; },
  });
  const store: ArtifactStore = {
    put: async input => {
      for await (const _chunk of input.body) { controller.abort(); await setImmediate(); }
      throw new Error('Aborted publication must not finish.');
    }, list: async () => [], fetch: async () => { throw new Error('Unexpected fetch.'); },
  };
  const tool = definition(createArtifactsToolkit({ store, tempRoot, sourceReader: async () => ({ name: 'file.bin', mimeType: 'application/octet-stream', body: source }) }), 'publish_artifact').tool;
  await assert.rejects(tool.invoke({ path: 'file.bin' }, { ...invocation(), signal: controller.signal }), { name: 'AbortError' });
  assert.equal(cancelled, true);
});

test('download cancellation cancels the source and leaves the previous target intact', async t => {
  const { tempRoot, workdir } = await fixture(t);
  await mkdir(workdir);
  const target = join(workdir, 'file.bin');
  await writeFile(target, 'existing');
  const { store, ref } = downloadFixture();
  const controller = new AbortController();
  let cancelled = false;
  store.fetch = async () => ({ ref, body: new ReadableStream<Uint8Array>({
    pull(streamController) { streamController.enqueue(Buffer.from('bytes')); void setImmediate().then(() => controller.abort()); },
    cancel() { cancelled = true; },
  }) });
  const tool = definition(createArtifactsToolkit({ store, sourceReader: unusedSource, tempRoot }), 'download_artifact').tool;
  await assert.rejects(tool.invoke({ uri: ref.uri, path: target }, { ...invocation('receiver', workdir), signal: controller.signal }), { name: 'AbortError' });
  // LangChain rejects an aborted invoke before cooperative stream/file cleanup
  // necessarily settles. Verify that cleanup completes rather than changing it.
  for (let attempt = 0; attempt < 20 && (!cancelled || (await readdir(workdir)).length !== 1); attempt += 1) await setImmediate();
  assert.equal(cancelled, true);
  assert.equal(await readFile(target, 'utf8'), 'existing');
  assert.deepEqual(await readdir(workdir), ['file.bin']);
});
