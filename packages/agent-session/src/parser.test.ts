import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_SESSION_SNAPSHOT_VERSION } from './domain';
import { parseAgentSessionSnapshot } from './parser';

test('parseAgentSessionSnapshot retains explicit session token usage', () => {
  const snapshot = parseAgentSessionSnapshot({
    version: AGENT_SESSION_SNAPSHOT_VERSION,
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
    version: AGENT_SESSION_SNAPSHOT_VERSION,
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

test('parseAgentSessionSnapshot retains and validates global review policy runtime state', () => {
  const base = {
    version: AGENT_SESSION_SNAPSHOT_VERSION,
    session: {
      sessionId: 'chat:pet',
      kind: 'chat',
      timeline: [],
      activeRun: null,
    },
  } as const;
  assert.equal(
    parseAgentSessionSnapshot({
      ...base,
      session: {
        ...base.session,
        runtime: {
          globalReviewPolicyMode: 'auto_authorization',
        },
      },
    })?.session.runtime?.globalReviewPolicyMode,
    'auto_authorization',
  );
  assert.equal(parseAgentSessionSnapshot({
    ...base,
    session: {
      ...base.session,
      runtime: {
        globalReviewPolicyMode: 'custom',
      },
    },
  }), null);
});
