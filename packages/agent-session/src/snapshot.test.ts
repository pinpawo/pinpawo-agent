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
    pendingInterrupt: null,
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

test('snapshot parser migrates legacy V3 reviews to the V5 interrupt boundary', () => {
  const parsed = parseAgentSessionSnapshot({
    version: 3,
    session: {
      sessionId: 'chat:legacy',
      kind: 'chat',
      timeline: [],
      activeRun: {
        requestId: 'req-review',
        state: 'waiting_review',
        reviewAction: {
          actionId: 'action-review',
          reviews: [{
            id: 'review-1',
            schemaVersion: 1,
            view: { kind: 'plain', body: 'Allow this operation?' },
            options: [{
              id: 'approve',
              label: 'Approve',
              decision: { type: 'approve' },
              effects: [{ type: 'graph.authorize_tool_action', scope: 'thread' }],
            }, {
              id: 'reject',
              label: 'Reject',
              decision: { type: 'reject', message: 'Rejected' },
            }],
          }],
        },
      },
    },
  });

  assert.equal(parsed?.version, AGENT_SESSION_SNAPSHOT_VERSION);
  assert.deepEqual(
    parsed?.session.pendingInterrupt?.payload.interactions,
    [{
      interactionId: 'review-1',
      schemaVersion: 2,
      view: { kind: 'plain', body: 'Allow this operation?' },
      options: [{
        id: 'approve',
        label: 'Approve',
        batchSubmission: 'defer',
      }, {
        id: 'reject',
        label: 'Reject',
        batchSubmission: 'immediate',
      }],
    }],
  );
  assert.equal(parseAgentSessionSnapshot({
    version: 3,
    session: {
      sessionId: 'chat:legacy',
      kind: 'chat',
      timeline: [],
      activeRun: {
        requestId: 'req-review',
        state: 'waiting_review',
        reviewAction: {
          actionId: 'action-review',
          reviews: [{
            id: 'review-empty',
            schemaVersion: 1,
            view: { kind: 'plain', body: 'No choices' },
            options: [],
          }],
        },
      },
    },
  }), null);
});

test('snapshot parser separates a V4 pending run and rejects it in V5', () => {
  const legacySession = {
    sessionId: 'chat:legacy-v4',
    kind: 'chat',
    timeline: [],
    activeRun: {
      state: 'pending_interrupt',
      pendingInterrupt: {
        interruptId: 'interrupt-v4',
        payload: {
          kind: 'human_review',
          interactions: [{
            interactionId: 'review-v4',
            schemaVersion: 2,
            view: { kind: 'plain', body: 'Approve?' },
            options: [{
              id: 'approve',
              label: 'Approve',
              batchSubmission: 'immediate',
            }],
          }],
        },
      },
    },
  };

  const parsed = parseAgentSessionSnapshot({
    version: 4,
    session: legacySession,
  });

  assert.equal(parsed?.version, AGENT_SESSION_SNAPSHOT_VERSION);
  assert.equal(parsed?.session.activeRun, null);
  assert.equal(
    parsed?.session.pendingInterrupt?.interruptId,
    'interrupt-v4',
  );
  assert.equal(parseAgentSessionSnapshot({
    version: AGENT_SESSION_SNAPSHOT_VERSION,
    session: {
      ...legacySession,
      pendingInterrupt: null,
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
      messageId: 'm-req-1',
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

test('current plan is a run-owned projection and snapshot field', () => {
  let projected = reduceSession(createSession(), {
    type: 'user.accepted',
    requestId: 'req-1',
    kind: 'chat',
    text: 'plan this work',
  }, { observedAt: 1_000 });
  const plan = {
    items: [{
      id: 'delegation-1',
      capability: 'explore',
      task: 'Inspect the repository',
      status: 'active' as const,
    }],
  };
  projected = reduceSession(projected, {
    type: 'runtime.event',
    event: { type: 'plan.updated', requestId: 'req-1', plan },
  }, { observedAt: 1_100 });
  projected = reduceSession(projected, {
    type: 'runtime.event',
    event: { type: 'plan.updated', requestId: 'other-run', plan: null },
  }, { observedAt: 1_200 });

  assert.deepEqual(projected.currentPlan, plan);
  const parsed = parseAgentSessionSnapshot(JSON.parse(JSON.stringify(
    createAgentSessionSnapshot(projected),
  )));
  assert.deepEqual(parsed?.session.currentPlan, plan);
  assert.deepEqual(applySessionSnapshot(createSession(), parsed!).currentPlan, plan);
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
    messageId: 'm-req-1',
    role: 'assistant' as const,
    text: 'done',
  };
  assert.deepEqual(buildAgentEventEnvelope(event), {
    type: 'event',
    requestId: 'req-1',
    event,
  });
});

test('protocol accepts plan replacement and rejects malformed plan items', () => {
  const event = {
    type: 'plan.updated' as const,
    requestId: 'req-1',
    plan: {
      items: [{
        id: 'delegation-1',
        capability: 'explore',
        task: 'Inspect code',
        status: 'active' as const,
      }],
    },
  };
  assert.deepEqual(parseAgentServerMessage(buildAgentEventEnvelope(event)), {
    type: 'event',
    requestId: 'req-1',
    event,
  });
  assert.equal(parseAgentServerMessage({
    type: 'event',
    requestId: 'req-1',
    event: {
      ...event,
      plan: { items: [{ ...event.plan.items[0], status: 'running' }] },
    },
  }), null);
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
