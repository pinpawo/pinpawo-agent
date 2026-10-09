import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { buildAgentContext } from '../../host/src/contextLoader';
import { createChatHostHandlers } from '../../host/src/serverHandlers';
import { createChatHostDepsStore } from '../../host/src/serverTypes';
import { attachHostWebSocketTransport } from '../../host/src/serverWsTransport';
import { buildHostRuntimeConfig } from '../../host/src/config/runtimeConfig';
import { createTestModelServerDeps } from '../../host/src/testing/modelProfiles';
import { createTestHostToolkitInventory } from '../../host/src/testing/toolkitInventory';
import { FileCapabilityArtifactStore } from '../../host/src/capabilityArtifactStore';
import { LocalHostConnection } from '../src/client/localHostConnection';
import { TuiSessionController } from '../src/session/sessionController';
import { ASSISTANT_MESSAGE, createHostGraphFixture, REVIEW_CANCEL_MESSAGE, REVIEW_REJECTED_REPLY } from './support/hostGraphFixture';

async function waitFor(done: () => boolean) {
  for (let i = 0; i < 500; i++) { if (done()) return; await Bun.sleep(5); }
  throw new Error('Timed out waiting for Host review completion.');
}

test('real Host transport completes cancelled review and accepts the next ordinary TUI input', { timeout: 10_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tui-review-stop-'));
  const runtimeConfig = buildHostRuntimeConfig(root);
  const fixture = createHostGraphFixture();
  const handlers = createChatHostHandlers(createChatHostDepsStore({
    serverMode: 'chat', petId: 'one', petName: 'One', runtimeConfig,
    ...createTestModelServerDeps({ apiKey: 'offline', baseUrl: 'http://127.0.0.1:1/v1', model: 'test', contextWindowTokens: 32_000 }),
    toolkitInventory: createTestHostToolkitInventory([]),
    capabilityArtifactStore: new FileCapabilityArtifactStore(runtimeConfig.capabilityArtifactRoot),
  }), { chatGraphService: fixture.service, loadContext: async petId => buildAgentContext(petId) });
  const server = createServer((_request, response) => { response.writeHead(404); response.end(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const authToken = 'offline-review-stop';
  const ws = attachHostWebSocketTransport(server, handlers.peerHandlers, { authToken, port: address.port });
  let requestCount = 0;
  const controller = new TuiSessionController({
    connectionFactory: connectionHandlers => new LocalHostConnection(connectionHandlers, {
      port: address.port, tokenProvider: () => authToken,
    }), requestIdFactory: () => `request-${++requestCount}`, snapshotTimeoutMs: 1_000,
  });
  try {
    controller.start();
    await waitFor(() => controller.getState().connection === 'ready');
    assert.equal(controller.submitChat(REVIEW_CANCEL_MESSAGE).ok, true);
    await waitFor(() => controller.getState().session.pendingInterrupt !== null);
    assert.equal(controller.cancelReview({ interruptId: controller.getState().session.pendingInterrupt!.interruptId }).ok, true);
    await waitFor(() => controller.getState().session.activeRun === null && controller.getState().session.pendingInterrupt === null);
    assert.ok(controller.getState().session.timeline.some(entry => entry.type === 'message'
      && entry.role === 'assistant' && entry.status === 'completed' && entry.text === REVIEW_REJECTED_REPLY));
    assert.deepEqual(controller.submitChat(''), { ok: false, reason: 'empty' });
    assert.equal(controller.submitChat('Continue with explicit new constraints.').ok, true);
    await waitFor(() => controller.getState().session.activeRun === null
      && controller.getState().session.timeline.some(entry => entry.type === 'message'
        && entry.role === 'assistant' && entry.status === 'completed' && entry.text === ASSISTANT_MESSAGE));
    assert.equal(fixture.reviewResumes().length, 1);
  } finally {
    controller.stop();
    for (const client of ws.clients) client.terminate();
    await Bun.sleep(10);
    server.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve, reject) => ws.close(error => error ? reject(error) : resolve())),
      new Promise<void>((resolve, reject) => server.close(error => error
        && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve())),
    ]);
    handlers.close();
    rmSync(root, { recursive: true, force: true });
  }
});
