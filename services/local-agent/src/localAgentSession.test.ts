import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LOCAL_AGENT_SESSION_SNAPSHOT_VERSION,
  type LocalAgentSessionSnapshot,
} from './localAgentSession';

test('LocalAgentSession snapshot owns one active run and one ordered timeline', () => {
  const snapshot: LocalAgentSessionSnapshot = {
    version: LOCAL_AGENT_SESSION_SNAPSHOT_VERSION,
    session: {
      sessionId: 'chat:pet',
      kind: 'chat',
      timeline: [{
        id: 'assistant-final',
        type: 'message',
        role: 'assistant',
        text: 'final answer',
        status: 'completed',
        requestId: 'req-1',
      }],
      activeRun: null,
      runtime: { model: 'gpt-test' },
      tokenUsage: {
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
      },
    },
  };

  assert.equal(snapshot.version, 3);
  assert.equal(snapshot.session.timeline[0]?.type, 'message');
  assert.equal(snapshot.session.activeRun, null);
});
