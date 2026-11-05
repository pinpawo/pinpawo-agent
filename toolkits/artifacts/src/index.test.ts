import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolMessage } from '@langchain/core/messages';
import type { ArtifactRef } from '@pinpawo/agent-contracts';
import {
  createArtifactsToolkit,
  limitArtifactBody,
  MAX_ARTIFACT_BYTES,
  type ArtifactStore,
} from './index';

function body(text: string) {
  return new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode(text));
    controller.close();
  } });
}

async function readBody(stream: ReadableStream<Uint8Array>) {
  return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}

const ref: ArtifactRef = {
  uri: 'artifact://workspace/first/report.txt', name: 'report.txt',
  mimeType: 'text/plain', size: 8, sha256: 'hash', createdAt: '2026-11-05T00:00:00.000Z',
};

function fixture() {
  const snapshots = new Map<string, { ref: ArtifactRef; text: string; threadId: string }>();
  const reads: Array<{ path: string; workdir: string | null }> = [];
  const writes: Array<{ path?: string; threadId: string; workdir: string | null; text: string }> = [];
  let source = 'snapshot';
  const store: ArtifactStore = {
    async put(input) {
      const published = { ...ref, ...(input.title !== undefined ? { title: input.title } : {}) };
      snapshots.set(published.uri, { ref: published, text: await readBody(input.body), threadId: input.threadId });
      return published;
    },
    async list(threadId) {
      return [...snapshots.values()].filter((item) => item.threadId === threadId).map((item) => item.ref);
    },
    async fetch(uri) {
      const item = snapshots.get(uri);
      if (!item) throw new Error('Not found');
      return { ref: item.ref, body: body(item.text) };
    },
  };
  const toolkit = createArtifactsToolkit({
    store,
    sourceReader: async (input) => {
      reads.push(input);
      return { name: 'report.txt', mimeType: 'text/plain', body: body(source) };
    },
    downloadWriter: async (input) => {
      writes.push({ ...input, text: await readBody(input.body) });
      return input.path ?? `/tmp/${input.threadId}/report.txt`;
    },
  });
  const definition = (name: string) => toolkit.tools.find((item) => item.tool.name === name)!;
  const config = (threadId = 'first') => ({ context: { executionScope: { threadId, workdir: '/work' } } });
  return { store, toolkit, definition, config, snapshots, reads, writes, setSource: (text: string) => { source = text; } };
}

test('publishing snapshots a local file, declares its reference, and lists only the execution session', async () => {
  const f = fixture();
  const result = await f.definition('publish_artifact').tool.invoke({
    name: 'publish_artifact', id: 'publish', type: 'tool_call', args: { path: 'report.txt', title: 'Report' },
  }, f.config());
  assert.ok(ToolMessage.isInstance(result));
  assert.deepEqual(result.artifact, { deliverables: [{ uri: ref.uri, title: 'Report' }] });
  assert.ok(String(result.content).includes(`[Report](${ref.uri})`));
  assert.deepEqual(f.reads, [{ path: 'report.txt', workdir: '/work' }]);
  f.setSource('changed after publication');
  assert.equal(f.snapshots.get(ref.uri)?.text, 'snapshot');
  const list = f.definition('list_artifacts').tool;
  assert.deepEqual(JSON.parse(String(await list.invoke({}, f.config()))), [{ ...ref, title: 'Report' }]);
  assert.deepEqual(JSON.parse(String(await list.invoke({}, f.config('second')))), []);
});

test('download accepts a shared reference and does not declare a second deliverable', async () => {
  const f = fixture();
  await f.definition('publish_artifact').tool.invoke({ path: 'report.txt' }, f.config());
  const result = await f.definition('download_artifact').tool.invoke({
    name: 'download_artifact', id: 'download', type: 'tool_call', args: { uri: ref.uri },
  }, f.config('second'));
  assert.ok(ToolMessage.isInstance(result));
  assert.equal(result.artifact, undefined);
  assert.deepEqual(JSON.parse(String(result.content)), { path: '/tmp/second/report.txt', ref });
  assert.deepEqual(f.writes.map(({ path, threadId, workdir, text }) => ({ path, threadId, workdir, text })), [
    { path: undefined, threadId: 'second', workdir: '/work', text: 'snapshot' },
  ]);
});

test('workdir download destinations request file-write review and exact authorization', async () => {
  const f = fixture();
  const definition = f.definition('download_artifact');
  const context = { toolkitName: 'artifacts', toolName: 'download_artifact',
    reviewCapabilities: { humanReview: true, sessionAuthorization: true } };
  assert.equal(await definition.review?.request({ ...context, input: { uri: ref.uri } }), null);
  assert.ok(await definition.review?.request({ ...context, input: { uri: ref.uri, path: 'report.txt' } }));
  const matcher = await definition.review?.authorization?.buildMatcher({ ...context,
    input: { uri: ref.uri, path: 'report.txt' } });
  assert.ok(matcher);
});

test('explicit temporary downloads skip review except for workdir paths and symlinked workdir parents', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-artifact-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workdir = join(root, 'workdir');
  const temporary = join(root, 'temporary');
  await Promise.all([mkdir(workdir), mkdir(temporary)]);
  const policy = fixture().definition('download_artifact').review!;
  const context = { toolkitName: 'artifacts', toolName: 'download_artifact', workdir,
    reviewCapabilities: { humanReview: true, sessionAuthorization: true } };
  const allowed = { ...context, input: { uri: ref.uri, path: join(temporary, 'report.txt') } };
  assert.equal(await policy.request(allowed), null);
  assert.equal(await policy.canAutoApprove?.(allowed), true);
  const inWorkdir = { ...context, input: { uri: ref.uri, path: join(workdir, 'report.txt') } };
  assert.ok(await policy.request(inWorkdir));
  assert.equal(await policy.canAutoApprove?.(inWorkdir), false);
  assert.ok(await policy.request({ ...context, input: { uri: ref.uri, path: 'report.txt' } }));
  if (process.platform !== 'win32') {
    const linked = join(temporary, 'linked-workdir');
    await symlink(workdir, linked, 'dir');
    const linkedWorkdir = { ...context, input: { uri: ref.uri, path: join(linked, 'report.txt') } };
    assert.ok(await policy.request(linkedWorkdir));
    assert.equal(await policy.canAutoApprove?.(linkedWorkdir), false);
  }
  assert.ok(await policy.request({ ...context, input: { uri: ref.uri, path: join(temporary, 'missing', 'report.txt') } }));
});

test('a missing execution session, URL source, or malformed reference cannot reach storage', async () => {
  const f = fixture();
  await assert.rejects(f.definition('publish_artifact').tool.invoke({ path: 'report.txt' }), /requires? an Agent session/);
  await assert.rejects(f.definition('publish_artifact').tool.invoke({ path: 'https://example.com/report.txt' }, f.config()));
  assert.equal(f.reads.length, 0);
  await assert.rejects(f.definition('download_artifact').tool.invoke({ uri: 'artifact://../secret' }, f.config()));
  assert.equal(f.writes.length, 0);
});

test('the publication limit rejects overflow and cancels the input rather than truncating it', async () => {
  const chunk = new Uint8Array(1024 * 1024);
  let pulled = 0;
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) { pulled += 1; controller.enqueue(chunk); },
    cancel() { cancelled = true; },
  });
  const reader = limitArtifactBody(source).getReader();
  let accepted = 0;
  await assert.rejects(async () => {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      accepted += item.value.byteLength;
    }
  }, /100 MB/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(accepted, MAX_ARTIFACT_BYTES);
  assert.ok(pulled <= 102);
  assert.equal(cancelled, true);
});

test('a temporary signed URL is consumed for download and is not returned to the agent', async () => {
  const f = fixture();
  f.store.fetch = async () => ({ ref, url: 'data:text/plain,snapshot', expiresAt: '2026-11-05T00:05:00.000Z' });
  const output = await f.definition('download_artifact').tool.invoke({ uri: ref.uri }, f.config());
  assert.equal(f.writes[0]?.text, 'snapshot');
  assert.equal(String(output).includes('data:text/plain'), false);
  assert.deepEqual(JSON.parse(String(output)).ref, ref);
});

test('aborting a bounded stream cancels its source', async () => {
  const abort = new AbortController();
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const reader = limitArtifactBody(source, abort.signal).getReader();
  const pending = reader.read();
  abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancelled, true);
});
