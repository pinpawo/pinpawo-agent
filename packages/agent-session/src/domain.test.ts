import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_SESSION_SNAPSHOT_VERSION,
  type AgentSessionSnapshot,
} from './index';

test('AgentSession snapshot owns one active run and one ordered timeline', () => {
  const snapshot: AgentSessionSnapshot = {
    version: AGENT_SESSION_SNAPSHOT_VERSION,
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
      sessionTokenUsage: {
        inputTokens: 30,
        outputTokens: 40,
        totalTokens: 70,
        scope: 'session',
      },
    },
  };

  assert.equal(snapshot.version, AGENT_SESSION_SNAPSHOT_VERSION);
  assert.equal(snapshot.session.timeline[0]?.type, 'message');
  assert.equal(snapshot.session.activeRun, null);
  assert.equal(snapshot.session.sessionTokenUsage?.totalTokens, 70);
});
