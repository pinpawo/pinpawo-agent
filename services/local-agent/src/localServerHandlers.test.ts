import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLocalServerHandlers } from './localServerHandlers';
import type { LocalAgentServerMessage } from './localAgentProtocol';
import type { LocalServerPeer } from './localServerPeer';
import type { LocalServerDeps } from './localServerTypes';
import { buildLocalAgentRuntimeConfig } from './runtimeConfig';

test('session.new returns an authoritative empty snapshot for a unique session', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'pinpawo-session-new-'));
  const sent: LocalAgentServerMessage[] = [];
  const peer: LocalServerPeer = {
    isConnected: () => true,
    send: (message) => {
      sent.push(message);
      return true;
    },
  };
  const handlers = createLocalServerHandlers({
    actorId: 'pet-a',
    workdir,
    runtimeConfig: buildLocalAgentRuntimeConfig(workdir),
    llmConfig: {
      provider: 'openai',
      model: 'test-model',
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
    } as LocalServerDeps['llmConfig'],
  });

  try {
    await handlers.peerHandlers.onSessionNew(peer, {
      type: 'session.new',
      requestId: 'new-1',
    });
    await handlers.peerHandlers.onSessionNew(peer, {
      type: 'session.new',
      requestId: 'new-2',
    });

    assert.equal(sent.length, 2);
    const first = sent[0];
    const second = sent[1];
    assert.equal(first?.type, 'session.new.result');
    assert.equal(second?.type, 'session.new.result');
    if (
      first?.type !== 'session.new.result'
      || second?.type !== 'session.new.result'
    ) {
      return;
    }
    assert.equal(first.requestId, 'new-1');
    assert.equal(first.session.id, first.snapshot.session.sessionId);
    assert.equal(first.snapshot.session.timeline.length, 0);
    assert.equal(first.snapshot.session.activeRun, null);
    assert.equal(first.session.active, true);
    assert.notEqual(second.session.id, first.session.id);
  } finally {
    handlers.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});
