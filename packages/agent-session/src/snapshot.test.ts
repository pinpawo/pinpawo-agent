import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_SESSION_SNAPSHOT_VERSION,
  applySessionSnapshot,
  buildAgentEventEnvelope,
  createAgentSessionSnapshot,
  parseAgentServerMessage,
  parseAgentSessionSnapshot,
  reduceSession,
  type AgentSession,
} from './index';

function createSession(): AgentSession {
  return {
    sessionId: 'chat:test',
    kind: 'chat',
    timeline: [],
    activeRun: null,
    runtime: {
      model: 'gpt-test',
      cwd: '/Users/example/project',
      contextWindow: 128_000,
    },
  };
}

test('snapshot factory versions the canonical session projection', () => {
  const session = createSession();
  const snapshot = createAgentSessionSnapshot(session);

  assert.equal(snapshot.version, AGENT_SESSION_SNAPSHOT_VERSION);
  assert.equal(snapshot.session, session);
});

test('snapshot parser accepts JSON session data and rejects invalid boundaries', () => {
  const session = createSession();
  session.timeline.push({
    id: 'op-1',
    type: 'operation',
    requestId: 'req-1',
    operationKey: 'read-1',
    kind: 'read_file',
    title: 'Read file',
    phase: 'completed',
    details: { path: 'README.md' },
    raw: { input: { path: 'README.md' }, output: 'contents' },
  });
  const snapshot = createAgentSessionSnapshot(session);

  assert.deepEqual(
    parseAgentSessionSnapshot(JSON.parse(JSON.stringify(snapshot))),
    snapshot,
  );
  assert.equal(parseAgentSessionSnapshot({
    ...snapshot,
    version: AGENT_SESSION_SNAPSHOT_VERSION + 1,
  }), null);
  assert.equal(parseAgentSessionSnapshot({
    ...snapshot,
    session: {
      ...snapshot.session,
      timeline: [{
        ...snapshot.session.timeline[0],
        details: { unsupported: 1n },
      }],
    },
  }), null);
});

test('snapshot parser rejects removed operation owner providers', () => {
  const snapshot = createAgentSessionSnapshot({
    ...createSession(),
    timeline: [{
      id: 'op-legacy',
      type: 'operation',
      requestId: 'req-1',
      operationKey: 'legacy-1',
      kind: 'legacy.read',
      title: 'Read',
      phase: 'completed',
      operationSource: {
        provider: 'toolkit',
        name: 'legacy-private-tools',
      },
    }],
  });
  const raw = JSON.parse(JSON.stringify(snapshot)) as {
    session: {
      timeline: Array<{
        operationSource?: {
          provider: string;
        };
      }>;
    };
  };
  if (raw.session.timeline[0]?.operationSource) {
    raw.session.timeline[0].operationSource.provider = 'toolset';
  }

  assert.equal(parseAgentSessionSnapshot(raw), null);
});

test('incremental projection and parsed snapshot converge', () => {
  let projected = createSession();
  projected = reduceSession(projected, {
    type: 'user.accepted',
    requestId: 'req-1',
    kind: 'chat',
    text: 'hello',
  }, { observedAt: 1_000 });
  projected = reduceSession(projected, {
    type: 'runtime.event',
    event: {
      type: 'message.completed',
      requestId: 'req-1',
      role: 'assistant',
      text: 'world',
    },
  }, { observedAt: 1_100 });

  const parsed = parseAgentSessionSnapshot(JSON.parse(JSON.stringify(
    createAgentSessionSnapshot(projected),
  )));
  assert.ok(parsed);
  const restored = applySessionSnapshot(createSession(), parsed);

  assert.deepEqual(restored.timeline, projected.timeline);
  assert.deepEqual(restored.activeRun, projected.activeRun);
});

test('protocol uses the same snapshot and runtime event contracts', () => {
  const snapshot = createAgentSessionSnapshot(createSession());
  assert.deepEqual(parseAgentServerMessage({
    type: 'session.snapshot.result',
    requestId: 'req-1',
    snapshot,
  }), {
    type: 'session.snapshot.result',
    requestId: 'req-1',
    snapshot,
  });

  const event = {
    type: 'message.completed' as const,
    requestId: 'req-1',
    role: 'assistant' as const,
    text: 'done',
  };
  assert.deepEqual(buildAgentEventEnvelope(event), {
    type: 'event',
    requestId: 'req-1',
    event,
  });
});

test('protocol parser does not project removed toolset providers', () => {
  const parsed = parseAgentServerMessage({
    type: 'event',
    requestId: 'req-1',
    event: {
      type: 'operation',
      requestId: 'req-1',
      phase: 'started',
      operation: {
        kind: 'legacy.read',
        source: {
          provider: 'toolset',
          name: 'legacy-private-tools',
          toolName: 'read',
        },
      },
    },
  });

  assert.equal(
    parsed?.type === 'event'
      && parsed.event.type === 'operation'
      ? parsed.event.operation.source?.provider
      : undefined,
    undefined,
  );
});
