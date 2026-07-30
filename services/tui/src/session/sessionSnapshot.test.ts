import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAgentSessionSnapshot,
  type AgentSession,
} from '@pinpawo/agent-session';
import { reconcileSessionSnapshot } from './sessionSnapshot';

test('completion snapshot replaces an idle timeline', () => {
  const live = session({
    timeline: [message('live-message', 'live reply')],
  });
  const snapshot = createAgentSessionSnapshot({
    sessionId: 'chat:one',
    kind: 'chat',
    timeline: [message('snapshot-message', 'canonical reply')],
    activeRun: null,
  });

  const reconciled = reconcileSessionSnapshot(
    live,
    snapshot,
    'completion',
    1_000,
  );

  assert.equal(reconciled.timeline[0]?.id, 'snapshot-message');
  assert.equal(
    reconciled.timeline[0]?.type === 'message'
      ? reconciled.timeline[0].text
      : null,
    'canonical reply',
  );
});

test('completion snapshot cannot replace a newer active timeline', () => {
  const live = session({
    timeline: [message('new-run', 'new prompt', 'user')],
    activeRun: {
      requestId: 'new-run',
      state: 'running',
      activity: 'thinking',
      startedAt: 1_000,
      updatedAt: 1_000,
    },
  });
  const snapshot = createAgentSessionSnapshot({
    sessionId: 'chat:one',
    kind: 'chat',
    timeline: [message('old-run', 'old reply')],
    activeRun: null,
    sessionTokenUsage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      scope: 'session',
    },
  });

  const reconciled = reconcileSessionSnapshot(
    live,
    snapshot,
    'completion',
    1_000,
  );

  assert.equal(reconciled.timeline, live.timeline);
  assert.equal(reconciled.activeRun, live.activeRun);
  assert.equal(reconciled.sessionTokenUsage?.totalTokens, 15);
});

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    sessionId: 'chat:one',
    kind: 'chat',
    timeline: [],
    activeRun: null,
    ...overrides,
  };
}

function message(
  id: string,
  text: string,
  role: 'assistant' | 'user' = 'assistant',
) {
  return {
    id,
    type: 'message' as const,
    role,
    text,
    status: 'completed' as const,
  };
}
