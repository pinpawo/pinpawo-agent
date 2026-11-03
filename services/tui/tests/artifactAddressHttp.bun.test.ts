import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FileArtifactStore } from '../../host/src/artifactStore';
import { resolveHostArtifactAddress } from '../../host/src/artifactAddress';
import { buildHostRuntimeConfig } from '../../host/src/config/runtimeConfig';
import { startHostServer } from '../../host/src/server';
import { createTestModelServerDeps } from '../../host/src/testing/modelProfiles';
import { artifactHttpAddress, createArtifactAddressCache, type ArtifactDisplayAddress } from '../src/client/artifactAddress';
import { downloadArtifact } from '../src/client/artifactDownload';
import { messageDisplayReferences } from '../src/client/artifactReferences';
import { LocalHostConnection } from '../src/client/localHostConnection';
import { resolveComposerIntent } from '../src/commands/composerIntent';
import { buildMessageDisplayLines } from '../src/timeline/messageDisplay';
import { formatTranscriptPagerText } from '../src/transcript/transcriptPager';

test('body-only references use the real authenticated connection and download Host snapshots to the TUI machine', async () => {
  const hostRoot = await mkdtemp(join(tmpdir(), 'pinpawo-artifact-host-'));
  const clientRoot = await mkdtemp(join(tmpdir(), 'pinpawo-artifact-client-'));
  const bytes = Buffer.from([0, 1, 10, 127, 255]);
  const source = join(hostRoot, 'original report.bin');
  await writeFile(source, bytes);
  const store = new FileArtifactStore(hostRoot, 'workspace');
  const sourceBytes = await readFile(source);
  const ref = await store.put({ threadId: 'session', name: "published owner's*report*(1)!.bin", mimeType: 'application/octet-stream',
    body: new ReadableStream({ start(controller) { controller.enqueue(sourceBytes); controller.close(); } }) });
  await rm(source);
  const hostPath = await store.resolvePath(ref.uri);
  const token = 'tui-artifact-transport-fixture';
  const runtimeConfig = { ...buildHostRuntimeConfig(hostRoot), sessionRoot: join(hostRoot, 'workspace'),
    checkpointPath: join(hostRoot, 'checkpoints.json'), tuiCheckpointPath: join(hostRoot, 'tui-checkpoints.json'),
    tuiSessionPath: join(hostRoot, 'sessions.json') };
  const transport = await startHostServer(0, { petId: 'pet', runtimeConfig, ...createTestModelServerDeps(),
    resolveArtifactAddress: uri => resolveHostArtifactAddress(store, uri) }, { authToken: token });
  const opened = Promise.withResolvers<void>();
  const pending = new Map<string, (result: ArtifactDisplayAddress | null) => void>();
  const connection = new LocalHostConnection({
    onOpen: () => opened.resolve(),
    onClose() {},
    onError: error => {
      opened.reject(error);
      for (const finish of pending.values()) finish(null);
    },
    onMessage: message => {
      if (message.type === 'artifact.address.result') pending.get(message.requestId)?.(message);
    },
  }, { port: transport.port, tokenProvider: () => token });
  let queries = 0;
  const cache = createArtifactAddressCache({
    // A loopback connection can be an SSH tunnel. Host paths are not client paths.
    sharedFilesystem: false,
    onChanged() {},
    read: uri => new Promise<ArtifactDisplayAddress | null>((resolve, reject) => {
      const requestId = `display-${++queries}`;
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error('Timed out waiting for the real Host address reply.'));
      }, 5_000);
      pending.set(requestId, result => {
        clearTimeout(timer);
        pending.delete(requestId);
        assert.equal(result?.address, hostPath);
        resolve(result);
      });
      if (!connection.send({ type: 'artifact.address.get', requestId, uri })) pending.get(requestId)?.(null);
    }),
  });
  try {
    connection.connect();
    await opened.promise;
    const url = artifactHttpAddress(ref.uri, transport.port);
    assert.equal(url.includes(token), false);
    const unauthorized = await fetch(url);
    assert.equal(unauthorized.status, 401);
    await unauthorized.body?.cancel();
    const entries = [
      { id: 'markdown', type: 'message' as const, role: 'assistant' as const, status: 'completed' as const,
        text: `[Published report](<${ref.uri}>)` },
      { id: 'bare', type: 'message' as const, role: 'assistant' as const, status: 'completed' as const, text: ref.uri },
    ];
    const canonical = JSON.stringify(entries);
    for (const entry of entries) {
      assert.equal('deliverables' in entry, false);
      const references = messageDisplayReferences(entry);
      assert.equal(references.length, 1);
      assert.equal(references[0]?.uri, ref.uri);
      await cache.ensure(references.map(reference => reference.uri));
      assert.equal(cache.display(ref.uri), `/download ${ref.uri}`);
      const rendered = buildMessageDisplayLines(entry, { artifactAddress: uri => cache.display(uri) }).map(line => line.text).join('\n');
      assert.ok(rendered.includes(`/download ${ref.uri}`));
      assert.equal(rendered.includes(hostPath), false);
      assert.equal(rendered.includes(url), false);
      assert.equal(rendered.includes(token), false);
    }
    assert.equal(queries, 1, 'address reads coalesce across body-only references');
    assert.deepEqual(await readdir(clientRoot), [], 'address lookup must not automatically download a file');

    const intent = resolveComposerIntent({ text: cache.display(ref.uri), attachmentCount: 0, mode: 'chat' });
    assert.equal(intent.type, 'download-artifact');
    if (intent.type !== 'download-artifact') throw new Error('Expected the displayed download action.');
    const clientPath = await downloadArtifact(intent.uri, { port: transport.port, tokenProvider: () => token, tempRoot: clientRoot });
    assert.ok(clientPath.startsWith(`${clientRoot}/`));
    assert.notEqual(clientPath, hostPath);
    assert.equal(clientPath.includes(token), false);
    assert.deepEqual(await readFile(clientPath), bytes, 'the snapshot remains available after the source file was deleted');
    const artifactAddress = (uri: string) => uri === ref.uri ? clientPath : cache.display(uri);
    const session = { sessionId: 'test', kind: 'chat' as const, timeline: entries, activeRun: null, pendingInterrupt: null };
    const transcript = formatTranscriptPagerText(session, artifactAddress);
    assert.ok(transcript.includes(clientPath));
    assert.equal(transcript.includes(hostPath), false);
    assert.equal(transcript.includes(token), false);
    for (const entry of entries) {
      assert.ok(buildMessageDisplayLines(entry, { artifactAddress }).at(-1)?.text.includes(clientPath));
    }
    assert.equal(JSON.stringify(entries), canonical, 'address resolution and downloading never rewrite canonical messages');
  } finally {
    connection.disconnect();
    transport.close();
    await transport.closed;
    await rm(hostRoot, { recursive: true, force: true });
    await rm(clientRoot, { recursive: true, force: true });
  }
});
