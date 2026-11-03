import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  EmbeddedHostConnection,
} from '../src/client/embeddedHostConnection';
import { TuiSessionController } from '../src/session/sessionController';
import { FileArtifactStore } from '../../host/src/artifactStore';
import { createArtifactAddressCache } from '../src/client/artifactAddress';
import { buildMessageDisplayLines } from '../src/timeline/messageDisplay';
import { formatTranscriptPagerText } from '../src/transcript/transcriptPager';
import { ASSISTANT_MESSAGE } from './support/hostGraphFixture';

const HOST_SCRIPT = fileURLToPath(new URL(
  './support/embeddedHostProcess.ts',
  import.meta.url,
));
const USER_MESSAGE = 'Inspect the embedded host.';

/**
 * The embedded transport in the shape the terminal UI actually uses it: the
 * session controller talks to a real Host child process over a piped JSONL
 * stream, with no WebSocket, port, or auth token involved.
 */
test('the embedded stdio transport drives the session controller against a real Host child', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'pinpawo-tui-embedded-host-'));
  let controller: TuiSessionController | null = null;
  let connection: EmbeddedHostConnection | null = null;
  const diagnostics: string[] = [];

  try {
    const store = new FileArtifactStore(join(workdir, 'objects'), 'workspace');
    const bytes = Buffer.from('The stdio display points at these actual published bytes.');
    const ref = await store.put({ threadId: 'stdio-session', name: 'report.txt', mimeType: 'text/plain',
      body: new ReadableStream({ start(sink) { sink.enqueue(bytes); sink.close(); } }) });
    let manualSnapshotApplied = false;
    let requestIndex = 0;
    controller = new TuiSessionController({
      connectionFactory: (handlers) => {
        connection = new EmbeddedHostConnection(handlers, {
          command: process.execPath,
          args: ['run', HOST_SCRIPT, workdir],
          cwd: workdir,
          onDiagnostics: (line) => diagnostics.push(line),
        });
        return connection;
      },
      requestIdFactory: () => `embedded-request-${requestIndex += 1}`,
      // Embedded stdio disconnects the Host on teardown, so the synchronization
      // timeout stays disabled exactly as `main.ts` configures it.
      snapshotTimeoutMs: null,
      onManualSnapshotApplied: () => { manualSnapshotApplied = true; },
    });

    controller.start();
    await waitFor(() => controller?.getState().connection === 'ready');
    assert.notEqual(controller.getState().session.sessionId, 'pending');
    assert.equal(connection!.isConnected(), true);

    assert.equal(controller.submitChat(USER_MESSAGE).ok, true);
    await waitFor(() => (
      controller?.getState().session.activeRun === null
      && completedMessages(controller).includes(`assistant:${ASSISTANT_MESSAGE}`)
    ));
    // The scripted graph also emits a subagent step; the canonical conversation
    // still travels both ways over the pipe.
    assert.deepEqual(completedMessages(controller), [
      `user:${USER_MESSAGE}`,
      `assistant:${ASSISTANT_MESSAGE}`,
    ]);

    assert.equal(controller.refreshSession().ok, true);
    await waitFor(() => manualSnapshotApplied);
    const canonical = JSON.stringify(controller.getState().session);
    let repaint = 0;
    const addresses = createArtifactAddressCache({
      read: uri => controller!.readArtifactAddress(uri),
      onChanged: () => { repaint += 1; },
    });
    assert.equal(addresses.display(ref.uri), ref.uri);
    await addresses.ensure([ref.uri]);
    const path = addresses.display(ref.uri);
    assert.equal(path, await store.resolvePath(ref.uri));
    assert.deepEqual(readFileSync(path), bytes);
    assert.equal(repaint, 1);
    const message = { id: 'display', type: 'message' as const, role: 'assistant' as const, text: 'Done.', status: 'completed' as const,
      deliverables: [{ uri: ref.uri, title: 'Report' }] };
    const artifactAddress = (uri: string) => addresses.display(uri);
    assert.ok(buildMessageDisplayLines(message, { artifactAddress }).some(line => line.text.includes(path)));
    assert.ok(formatTranscriptPagerText({ ...controller.getState().session, timeline: [message] }, artifactAddress).includes(path));
    assert.equal(await controller.readArtifactAddress(ref.uri.replace(/[^/]+$/, 'missing%2Etxt')), null);
    assert.equal(JSON.stringify(controller.getState().session), canonical, 'display results and errors never enter canonical history');
    assert.equal(canonical.includes(path), false);
    assert.equal(canonical.includes('signature='), false);

    controller.stop();
    // Stopping the session ends the Host child instead of leaving it running.
    await waitFor(() => connection?.isConnected() === false);
  } finally {
    controller?.stop();
    rmSync(workdir, { recursive: true, force: true });
  }
});

function completedMessages(controller: TuiSessionController) {
  return controller.getState().session.timeline.flatMap((entry) => (
    entry.type === 'message'
    && entry.status === 'completed'
    && (entry.role === 'user' || entry.role === 'assistant')
      ? [`${entry.role}:${entry.text}`]
      : []
  ));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`condition was not met within ${timeoutMs}ms`);
    }
    await Bun.sleep(10);
  }
}
