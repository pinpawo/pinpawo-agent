import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAgentSessionSnapshot } from './parser';

test('parseAgentSessionSnapshot retains explicit session token usage', () => {
  const snapshot = parseAgentSessionSnapshot({
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

test('parseAgentSessionSnapshot rejects a run-scoped session aggregate', () => {
  const snapshot = parseAgentSessionSnapshot({
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
