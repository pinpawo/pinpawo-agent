import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLocalAgentSessionSnapshot } from './localAgentSessionParser';

test('parseLocalAgentSessionSnapshot retains explicit session token usage', () => {
  const snapshot = parseLocalAgentSessionSnapshot({
    version: 3,
    session: {
      sessionId: 'chat:pet',
      kind: 'chat',
      timeline: [],
      activeRun: null,
      sessionTokenUsage: {
        inputTokens: 20,
        outputTokens: 5,
        totalTokens: 25,
        scope: 'session',
      },
    },
  });

  assert.deepEqual(snapshot?.session.sessionTokenUsage, {
    inputTokens: 20,
    outputTokens: 5,
    totalTokens: 25,
    scope: 'session',
  });
});

test('parseLocalAgentSessionSnapshot rejects a run-scoped session aggregate', () => {
  const snapshot = parseLocalAgentSessionSnapshot({
    version: 3,
    session: {
      sessionId: 'chat:pet',
      kind: 'chat',
      timeline: [],
      activeRun: null,
      sessionTokenUsage: {
        inputTokens: 20,
        outputTokens: 5,
        totalTokens: 25,
        scope: 'run',
      },
    },
  });

  assert.equal(snapshot?.session.sessionTokenUsage, undefined);
});
