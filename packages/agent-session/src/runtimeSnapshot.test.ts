import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applySessionSnapshot,
  createAgentSessionSnapshot,
  reduceSession,
  type AgentRuntimeView,
  type AgentSession,
} from './index';

function session(sessionId = 'chat:one', runtime?: AgentRuntimeView): AgentSession {
  return {
    sessionId,
    kind: 'chat',
    timeline: [],
    activeRun: null,
    pendingInterrupt: null,
    ...(runtime ? { runtime } : {}),
  };
}

const available: AgentRuntimeView = {
  modelProfileId: 'available',
  model: 'model-A',
  inputModalities: ['text', 'image'],
  contextWindow: 128_000,
  contextCompactionWatermarkTokens: 110_000,
};

for (const sessionId of ['chat:one', 'chat:two']) {
  test(`runtime snapshot clears stale profile fields for ${sessionId}`, () => {
    const unavailable: AgentRuntimeView = {
      modelProfileId: 'missing',
      modelProfileLabel: 'missing',
      modelProfileAvailable: false,
      modelProfileIssues: ['Unknown model profile "missing"'],
      hostVersion: '1.0.0',
    };
    const snapshot = createAgentSessionSnapshot(session(sessionId, unavailable));

    const applied = applySessionSnapshot(session('chat:one', available), snapshot);

    assert.equal(applied.sessionId, sessionId);
    assert.deepEqual(applied.runtime, unavailable);
    assert.deepEqual(available.inputModalities, ['text', 'image']);
  });
}

test('a complete valid runtime snapshot replaces the previous profile', () => {
  const runtime: AgentRuntimeView = {
    modelProfileId: 'text',
    modelProfileAvailable: true,
    model: 'model-B',
    inputModalities: ['text'],
    contextWindow: 64_000,
    contextCompactionWatermarkTokens: 50_000,
  };
  const applied = applySessionSnapshot(
    session('chat:one', available),
    createAgentSessionSnapshot(session('chat:one', runtime)),
  );

  assert.deepEqual(applied.runtime, runtime);
});

test('a snapshot without runtime does not inherit a previous runtime', () => {
  const applied = applySessionSnapshot(
    session('chat:one', available),
    createAgentSessionSnapshot(session()),
  );

  assert.equal(applied.runtime, undefined);
});

test('session.configured retains its explicit runtime patch semantics', () => {
  const configured = reduceSession(session('chat:one', available), {
    type: 'session.configured',
    runtime: { hostVersion: '2.0.0' },
  }, { observedAt: 1_000 });

  assert.deepEqual(configured.runtime, { ...available, hostVersion: '2.0.0' });
});
