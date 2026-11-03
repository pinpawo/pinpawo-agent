import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import test from 'node:test';
import { WebSocket } from 'ws';
import type { ArtifactRef } from '@pinpawo/agent-contracts';
import { FileArtifactStore } from './artifactStore';
import { CosArtifactStore, type CosArtifactClient } from './cosArtifactStore';
import { resolveHostArtifactAddress } from './artifactAddress';
import { AgentHost } from './runtime';
import { startLocalStdioServer } from './chatStdioServer';
import { startHostServer } from './server';
import { buildHostRuntimeConfig } from './config/runtimeConfig';
import { createChatHostHandlers } from './serverHandlers';
import { createChatHostDepsStore } from './serverTypes';
import { createTestModelServerDeps } from './testing/modelProfiles';
import type { HostServerMessage } from './wire/protocol';

test('local display address validates the existing file without fetching a stream or creating a download', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-artifact-address-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileArtifactStore(root, 'workspace');
  const ref = await store.put({ threadId: 'session:one', name: 'report.txt', mimeType: 'text/plain',
    body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('published')); controller.close(); } }) });
  const before = (await readdir(root, { recursive: true })).sort();
  store.fetch = async () => { throw new Error('Local address lookup must not open a stream.'); };
  const result = await resolveHostArtifactAddress(store, ref.uri);
  assert.equal(await readFile(result.address, 'utf8'), 'published');
  assert.equal(result.expiresAt, undefined);
  assert.deepEqual((await readdir(root, { recursive: true })).sort(), before);
  await assert.rejects(() => resolveHostArtifactAddress(store, 'https://example.test/not-an-artifact'), TypeError);
  await assert.rejects(() => resolveHostArtifactAddress(store,
    ref.uri.replace(/\/[^/]+\/[^/]+$/, '/00000000-0000-4000-8000-000000000000/missing.txt')), { code: 'ENOENT' });
});

test('production Chat deps answer actual stdio JSONL locally without a listener or session writes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-chat-artifact-address-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeConfig = { ...buildHostRuntimeConfig(root), sessionRoot: join(root, 'workspace'),
    checkpointPath: join(root, 'checkpoints.json'), tuiCheckpointPath: join(root, 'tui-checkpoints.json'), tuiSessionPath: join(root, 'sessions.json') };
  const store = new FileArtifactStore(root, 'workspace');
  const ref = await store.put({ threadId: 'session:one', name: 'report.txt', mimeType: 'text/plain',
    body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('published')); controller.close(); } }) });
  const host = new AgentHost(runtimeConfig);
  const input = new PassThrough();
  const output = new PassThrough();
  const diagnostics = new PassThrough();
  let text = '';
  let logs = '';
  output.on('data', chunk => { text += chunk.toString(); });
  diagnostics.on('data', chunk => { logs += chunk.toString(); });
  const transport = startLocalStdioServer(host.buildChatHostDeps(), { input, output, diagnostics });
  const before = (await readdir(root, { recursive: true })).sort();
  try {
    input.write(`${JSON.stringify({ type: 'artifact.address.get', requestId: 'local', uri: ref.uri })}\n`);
    input.write(`${JSON.stringify({ type: 'artifact.address.get', requestId: 'bad', uri: 'https://example.test/file' })}\n`);
    input.write(`${JSON.stringify({ type: 'artifact.address.get', requestId: 'missing', uri:
      ref.uri.replace(/\/[^/]+\/[^/]+$/, '/00000000-0000-4000-8000-000000000000/missing.txt') })}\n`);
    input.write(`${JSON.stringify({ type: 'ping' })}\n`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { output.off('data', check); reject(new Error('Timed out waiting for stdio replies.')); }, 2_000);
      const check = () => {
        if (text.trim().split('\n').filter(Boolean).length < 4) return;
        clearTimeout(timer); output.off('data', check); resolve();
      };
      output.on('data', check); check();
    });
    input.end();
    await transport.closed;
    const messages = text.trim().split('\n').map(line => JSON.parse(line) as HostServerMessage);
    const address = messages.find(message => message.type === 'artifact.address.result');
    assert.deepEqual(address, { type: 'artifact.address.result', requestId: 'local', uri: ref.uri,
      address: await store.resolvePath(ref.uri) });
    assert.ok(messages.some(message => message.type === 'pong'));
    for (const [requestId, expected] of [['bad', 'Invalid artifact URI.'], ['missing', 'Artifact not found.']]) {
      const failure = messages.find(message => 'requestId' in message && message.requestId === requestId);
      assert.equal(failure?.type, 'event');
      assert.equal(failure?.type === 'event' && failure.event.type === 'error' ? failure.event.message : undefined, expected);
    }
    assert.equal(messages.length, 4);
    assert.equal(logs, '');
    assert.deepEqual((await readdir(root, { recursive: true })).sort(), before);
  } finally {
    transport.close();
    await transport.closed;
    await host.shutdown();
  }
});

test('COS display address and failures return only to the requesting peer without publishing runtime events', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-cos-artifact-address-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ref: ArtifactRef = { uri: 'artifact://workspace/c2Vzc2lvbg/object/report.txt', name: 'report.txt',
    mimeType: 'text/plain', size: 5, sha256: 'a'.repeat(64), createdAt: '2026-01-01T00:00:00Z' };
  const url = 'https://bucket.cos.example.test/report?signature=temporary';
  const client: CosArtifactClient = {
    getObject: async () => ({ Body: Buffer.from(JSON.stringify(ref)) }),
    getObjectUrl: (_params, callback) => callback(null, { Url: url }),
    putObject: async () => { throw new Error('Must not write.'); },
    deleteObject: async () => { throw new Error('Must not delete.'); },
    getBucket: async () => { throw new Error('Must not list.'); }, cancelTask: () => undefined,
  };
  const store = new CosArtifactStore({ workspaceId: 'workspace', bucket: 'bucket', region: 'region',
    secretId: 'test-only-id', secretKey: 'test-only-key' }, client);
  const replies: HostServerMessage[] = [];
  const broadcast: unknown[] = [];
  const deps = { petId: 'pet', runtimeConfig: buildHostRuntimeConfig(root), ...createTestModelServerDeps(),
    resolveArtifactAddress: (uri: string) => resolveHostArtifactAddress(store, uri) };
  const handlers = createChatHostHandlers(createChatHostDepsStore(deps), {
    publishRuntimeEvent: (_peer, event) => { broadcast.push(event); },
  });
  const before = (await readdir(root, { recursive: true })).sort();
  try {
    await handlers.peerHandlers.onArtifactAddressGet!({ isConnected: () => true,
      send: message => { replies.push(message); return true; } }, { type: 'artifact.address.get', requestId: 'cos', uri: ref.uri });
    const response = replies[0];
    assert.equal(response?.type, 'artifact.address.result');
    if (response?.type !== 'artifact.address.result') throw new Error('Expected an address response.');
    assert.equal(response.address, url);
    assert.ok(Date.parse(response.expiresAt!) > Date.now());
    assert.deepEqual(broadcast, []);
    assert.deepEqual((await readdir(root, { recursive: true })).sort(), before);
    deps.resolveArtifactAddress = async () => { throw new Error(`SDK private request ${url}`); };
    const failureHandlers = createChatHostHandlers(createChatHostDepsStore(deps));
    try {
      await failureHandlers.peerHandlers.onArtifactAddressGet!({ isConnected: () => true,
        send: message => { replies.push(message); return true; } }, { type: 'artifact.address.get', requestId: 'failure', uri: ref.uri });
      assert.doesNotMatch(JSON.stringify(replies.at(-1)), /signature|SDK private/);
      assert.equal(replies.at(-1)?.type, 'event');
    } finally { failureHandlers.close(); }
  } finally { handlers.close(); }
});

test('an embedded runtime without an address resolver returns the existing request error', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-no-artifact-address-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sent: HostServerMessage[] = [];
  const handlers = createChatHostHandlers(createChatHostDepsStore({ petId: 'pet',
    runtimeConfig: buildHostRuntimeConfig(root), ...createTestModelServerDeps() }));
  try {
    await handlers.peerHandlers.onArtifactAddressGet!({ isConnected: () => true,
      send: message => { sent.push(message); return true; } }, {
      type: 'artifact.address.get', requestId: 'unavailable', uri: 'artifact://workspace/session/object/file.txt',
    });
    assert.equal(sent[0]?.type, 'event');
    assert.equal(sent[0]?.type === 'event' && sent[0].event.type === 'error' ? sent[0].event.requestId : undefined, 'unavailable');
  } finally { handlers.close(); }
});

test('the existing authenticated Chat WebSocket answers an address query using production Host deps', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-ws-artifact-address-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeConfig = { ...buildHostRuntimeConfig(root), sessionRoot: join(root, 'workspace'),
    checkpointPath: join(root, 'checkpoints.json'), tuiCheckpointPath: join(root, 'tui-checkpoints.json'), tuiSessionPath: join(root, 'sessions.json') };
  const store = new FileArtifactStore(root, 'workspace');
  const ref = await store.put({ threadId: 'session', name: 'report.txt', mimeType: 'text/plain',
    body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('published')); controller.close(); } }) });
  const host = new AgentHost(runtimeConfig);
  const transport = await startHostServer(0, host.buildChatHostDeps(), { authToken: 'address-test-token' });
  const socket = new WebSocket(`ws://127.0.0.1:${transport.port}`, { headers: { Authorization: 'Bearer address-test-token' } });
  try {
    await once(socket, 'open');
    const response = once(socket, 'message');
    socket.send(JSON.stringify({ type: 'artifact.address.get', requestId: 'ws', uri: ref.uri }));
    const [bytes] = await response;
    assert.deepEqual(JSON.parse(bytes.toString()), { type: 'artifact.address.result', requestId: 'ws', uri: ref.uri,
      address: await store.resolvePath(ref.uri) });
  } finally {
    const closed = once(socket, 'close'); socket.close(); await closed;
    transport.close(); await transport.closed;
    await host.shutdown();
  }
});
