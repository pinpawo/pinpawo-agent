import assert from 'node:assert/strict';
import test from 'node:test';
import type { LocalAgentSession } from './localAgentSession';
import {
  applySessionSnapshot,
  reduceSession,
  type LocalAgentSessionInput,
} from './localAgentSessionReducer';
import { createInitialTuiState, createSession } from './tui/state/tuiState';
import { tuiStateReducer } from './tui/state/tuiStateReducer';

function createDomainSession(): LocalAgentSession {
  return {
    sessionId: 'chat:pet',
    kind: 'chat',
    timeline: [],
    activeRun: null,
    runtime: { contextWindow: 128_000 },
  };
}

function replay(
  initial: LocalAgentSession,
  inputs: Array<{ input: LocalAgentSessionInput; observedAt: number }>,
) {
  return inputs.reduce(
    (session, item) => reduceSession(session, item.input, { observedAt: item.observedAt }),
    initial,
  );
}

test('reduceSession deterministically replays canonical run inputs', () => {
  const inputs: Array<{ input: LocalAgentSessionInput; observedAt: number }> = [
    {
      input: {
        type: 'user.accepted',
        requestId: 'req-1',
        kind: 'chat',
        text: 'check the repository',
      },
      observedAt: 1_000,
    },
    {
      input: {
        type: 'runtime.event',
        event: {
          type: 'operation',
          requestId: 'req-1',
          phase: 'started',
          operation: {
            id: 'tool-1',
            kind: 'shell',
            title: 'Run command',
            target: 'npm test',
            summary: 'running tests',
            details: { cwd: '/repo' },
          },
          raw: { input: { command: 'npm test' } },
        },
      },
      observedAt: 1_100,
    },
    {
      input: {
        type: 'runtime.event',
        event: {
          type: 'operation',
          requestId: 'req-1',
          phase: 'completed',
          operation: {
            id: 'tool-1',
            kind: 'shell',
            details: { exitCode: 0 },
          },
          raw: { output: 'passed' },
        },
      },
      observedAt: 1_200,
    },
    {
      input: {
        type: 'runtime.event',
        event: {
          type: 'message.delta',
          requestId: 'req-1',
          role: 'assistant',
          text: 'All ',
        },
      },
      observedAt: 1_300,
    },
    {
      input: {
        type: 'runtime.event',
        event: {
          type: 'subagent.message.delta',
          requestId: 'req-1',
          text: 'worker output',
        },
      },
      observedAt: 1_350,
    },
    {
      input: {
        type: 'runtime.event',
        event: {
          type: 'message.completed',
          requestId: 'req-1',
          role: 'assistant',
          text: 'All tests passed.',
          usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
        },
      },
      observedAt: 1_400,
    },
  ];

  const first = replay(createDomainSession(), inputs);
  const second = replay(createDomainSession(), inputs);

  assert.deepEqual(first, second);
  assert.equal(first.activeRun, null);
  assert.equal(first.timeline[0]?.id, 'req-1:message:user:0');
  assert.equal(first.timeline[1]?.id, 'req-1:operation:tool-1');
  assert.deepEqual(first.timeline[1], {
    id: 'req-1:operation:tool-1',
    type: 'operation',
    requestId: 'req-1',
    operationKey: 'tool-1',
    kind: 'shell',
    title: 'Run command',
    phase: 'completed',
    source: 'live-event',
    target: 'npm test',
    summary: 'running tests',
    details: { cwd: '/repo', exitCode: 0 },
    startedAt: 1_100,
    updatedAt: 1_200,
    completedAt: 1_200,
    raw: { input: { command: 'npm test' }, output: 'passed' },
  });
  assert.equal(first.timeline[2]?.id, 'req-1:assistant:0');
  assert.equal(first.timeline[2]?.type === 'message' ? first.timeline[2].status : undefined, 'completed');
  assert.equal(first.timeline[3]?.id, 'req-1:subagent-output');
  assert.equal(first.timeline[3]?.type === 'message' ? first.timeline[3].status : undefined, 'completed');
  assert.deepEqual(first.tokenUsage, {
    inputTokens: 10,
    outputTokens: 4,
    totalTokens: 14,
    contextWindow: 128_000,
  });
});

test('reduceSession keeps review and terminal control scoped to the owning run', () => {
  let session = reduceSession(createDomainSession(), {
    type: 'user.accepted',
    requestId: 'req-1',
    kind: 'chat',
    text: 'continue',
  }, { observedAt: 1_000 });
  session = reduceSession(session, {
    type: 'runtime.event',
    event: {
      type: 'human_review.requested',
      requestId: 'req-1',
      review: {
        id: 'review-1',
        schemaVersion: 1,
        view: { kind: 'plain', body: 'Approve?' },
        options: [],
      },
    },
  }, { observedAt: 1_100 });

  assert.equal(
    session.activeRun?.reviewAction?.actionId,
    'request:req-1:reviews:review-1',
  );
  const unknownRun = reduceSession(session, {
    type: 'run.interrupting',
    requestId: 'req-other',
  }, { observedAt: 1_200 });
  assert.equal(unknownRun, session);

  session = reduceSession(session, {
    type: 'runtime.event',
    event: {
      type: 'operation',
      requestId: 'req-1',
      phase: 'completed',
      operation: {
        id: 'tool-1',
        kind: 'shell',
      },
    },
  }, { observedAt: 1_200 });
  assert.equal(session.activeRun?.phase, 'thinking');
  assert.equal(session.activeRun?.reviewAction, undefined);

  session = reduceSession(session, {
    type: 'run.interrupting',
    requestId: 'req-1',
  }, { observedAt: 1_300 });
  assert.equal(session.activeRun?.phase, 'interrupting');
  assert.equal(session.activeRun?.reviewAction, undefined);
});

test('applySessionSnapshot rematerializes timeline state from a checkpoint point', () => {
  const live = replay(createDomainSession(), [
    {
      input: {
        type: 'user.accepted',
        requestId: 'req-1',
        kind: 'chat',
        text: 'hello',
      },
      observedAt: 1_700_000_000_000,
    },
    {
      input: {
        type: 'runtime.event',
        event: {
          type: 'operation',
          requestId: 'req-1',
          phase: 'started',
          operation: {
            id: 'tool-1',
            kind: 'shell',
            title: 'Run command',
          },
        },
      },
      observedAt: 1_700_000_000_050,
    },
    {
      input: {
        type: 'runtime.event',
        event: {
          type: 'subagent.message.delta',
          requestId: 'req-1',
          text: 'ephemeral',
        },
      },
      observedAt: 1_700_000_000_100,
    },
  ]);
  const withUsage = {
    ...live,
    tokenUsage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
  };
  const snapshot = {
    version: 1 as const,
    session: {
      sessionId: 'chat:pet',
      kind: 'chat' as const,
      timeline: [{
        id: 'checkpoint:user:1',
        type: 'message' as const,
        role: 'user' as const,
        text: 'checkpoint message',
        status: 'completed' as const,
        source: 'checkpoint' as const,
      }],
      activeRun: {
        requestId: 'req-1',
        phase: 'thinking' as const,
        startedAt: 1_700_000_000,
      },
    },
  };

  assert.deepEqual(live.timeline.map((entry) => entry.type), [
    'message',
    'operation',
    'message',
  ]);

  const completed = applySessionSnapshot(
    withUsage,
    snapshot,
    {
      observedAt: 1_700_000_000_200,
      preserveOmittedTokenUsage: true,
    },
  );
  assert.deepEqual(completed.timeline, snapshot.session.timeline);
  assert.equal(completed.activeRun?.startedAt, 1_700_000_000_000);
  assert.deepEqual(completed.tokenUsage, withUsage.tokenUsage);

  const started = applySessionSnapshot(withUsage, snapshot, {
    observedAt: 1_700_000_000_200,
  });
  assert.equal(started.tokenUsage, undefined);
});

test('TUI actions preserve the shared session reducer projection', () => {
  const tuiInitial = createInitialTuiState(createSession({ id: 'chat:pet' }));
  let tuiState = tuiStateReducer(tuiInitial, {
    type: 'run.start',
    requestId: 'req-1',
    kind: 'chat',
    message: {
      id: 'message:user-1',
      role: 'user',
      text: 'hello',
      requestId: 'req-1',
      source: 'local-input',
      createdAt: new Date(1_000).toISOString(),
    },
    now: 1_000,
  });
  let shared = reduceSession(tuiInitial.sessions['chat:pet'], {
    type: 'user.accepted',
    requestId: 'req-1',
    kind: 'chat',
    text: 'hello',
    message: { id: 'message:user-1', createdAt: new Date(1_000).toISOString() },
  }, { observedAt: 1_000 });

  const delta = {
    type: 'message.delta' as const,
    requestId: 'req-1',
    role: 'assistant' as const,
    text: 'hi',
  };
  tuiState = tuiStateReducer(tuiState, {
    type: 'event.received',
    event: delta,
    now: 1_100,
  });
  shared = reduceSession(shared, {
    type: 'runtime.event',
    event: delta,
    message: {
      role: 'assistant',
      requestId: 'req-1',
      text: 'hi',
      source: 'live-event',
      createdAt: new Date(1_100).toISOString(),
    },
  }, { observedAt: 1_100 });

  const completed = {
    type: 'message.completed' as const,
    requestId: 'req-1',
    role: 'assistant' as const,
    text: 'hi there',
  };
  tuiState = tuiStateReducer(tuiState, {
    type: 'event.received',
    event: completed,
    now: 1_200,
  });
  shared = reduceSession(shared, {
    type: 'runtime.event',
    event: completed,
    message: {
      role: 'assistant',
      requestId: 'req-1',
      text: 'hi there',
      source: 'live-event',
      createdAt: new Date(1_200).toISOString(),
    },
  }, { observedAt: 1_200 });

  assert.deepEqual(tuiState.sessions['chat:pet'], shared);
});
