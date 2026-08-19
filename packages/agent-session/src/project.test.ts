import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_SESSION_SNAPSHOT_VERSION,
  applySessionSnapshot,
  reduceSession,
  type AgentSession,
  type AgentSessionInput,
  type AgentTimelineEntry,
} from './index';

function createDomainSession(): AgentSession {
  return {
    sessionId: 'chat:pet',
    kind: 'chat',
    timeline: [],
    activeRun: null,
    runtime: { contextWindow: 128_000 },
  };
}

function replay(
  initial: AgentSession,
  inputs: Array<{ input: AgentSessionInput; observedAt: number }>,
) {
  return inputs.reduce(
    (session, item) => reduceSession(session, item.input, { observedAt: item.observedAt }),
    initial,
  );
}

test('reduceSession deterministically replays canonical run inputs', () => {
  const inputs: Array<{ input: AgentSessionInput; observedAt: number }> = [
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
          messageId: 'm-req-1',
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
          type: 'subagent.message.completed',
          requestId: 'req-1',
          messageId: 'child-1',
          namespace: ['general:t1', 'model_request:t2'],
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
          messageId: 'm-req-1',
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
    target: 'npm test',
    summary: 'running tests',
    details: { cwd: '/repo', exitCode: 0 },
    startedAt: 1_100,
    updatedAt: 1_200,
    completedAt: 1_200,
    raw: { input: { command: 'npm test' }, output: 'passed' },
  });
  assert.equal(first.timeline[2]?.id, 'req-1:assistant:m-req-1');
  assert.equal(first.timeline[2]?.type === 'message' ? first.timeline[2].status : undefined, 'completed');
  assert.equal(first.timeline[3]?.id, 'req-1:subagent:general:t1|model_request:t2:child-1');
  assert.equal(first.timeline[3]?.type === 'message' ? first.timeline[3].status : undefined, 'completed');
  assert.deepEqual(first.tokenUsage, {
    inputTokens: 10,
    outputTokens: 4,
    totalTokens: 14,
    contextWindow: 128_000,
  });
  assert.deepEqual(first.sessionTokenUsage, {
    inputTokens: 10,
    outputTokens: 4,
    totalTokens: 14,
    contextWindow: 128_000,
    scope: 'session',
  });
});

test('a completed final operation returns a running session to thinking', () => {
  let session = reduceSession(createDomainSession(), {
    type: 'user.accepted',
    requestId: 'req-1',
    kind: 'chat',
    text: 'inspect',
  }, { observedAt: 1_000 });
  session = reduceSession(session, {
    type: 'runtime.event',
    event: {
      type: 'operation',
      requestId: 'req-1',
      phase: 'started',
      operation: { id: 'tool-1', kind: 'shell' },
    },
  }, { observedAt: 1_100 });
  assert.equal(
    session.activeRun?.state === 'running' ? session.activeRun.activity : null,
    'using_tool',
  );

  session = reduceSession(session, {
    type: 'runtime.event',
    event: {
      type: 'operation',
      requestId: 'req-1',
      phase: 'completed',
      operation: { id: 'tool-1', kind: 'shell' },
    },
  }, { observedAt: 1_200 });
  assert.equal(
    session.activeRun?.state === 'running' ? session.activeRun.activity : null,
    'thinking',
  );
});

test('reduceSession accumulates usage across runs and clears only run usage on submit', () => {
  let session = reduceSession(createDomainSession(), {
    type: 'user.accepted',
    requestId: 'req-1',
    kind: 'chat',
    text: 'first',
  }, { observedAt: 1_000 });
  session = reduceSession(session, {
    type: 'runtime.event',
    event: {
      type: 'message.completed',
      requestId: 'req-1',
      messageId: 'm-req-1',
      role: 'assistant',
      text: 'first answer',
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
        latestInputTokens: 9,
        scope: 'run',
      },
    },
  }, { observedAt: 1_100 });

  session = reduceSession(session, {
    type: 'user.accepted',
    requestId: 'req-2',
    kind: 'chat',
    text: 'second',
  }, { observedAt: 1_200 });
  assert.equal(session.tokenUsage, undefined);
  assert.equal(session.sessionTokenUsage?.totalTokens, 14);

  session = reduceSession(session, {
    type: 'runtime.event',
    event: {
      type: 'message.completed',
      requestId: 'req-2',
      messageId: 'm-req-2',
      role: 'assistant',
      text: 'second answer',
      usage: {
        inputTokens: 8,
        outputTokens: 3,
        totalTokens: 11,
        latestInputTokens: 15,
        scope: 'run',
      },
    },
  }, { observedAt: 1_300 });

  assert.deepEqual(session.sessionTokenUsage, {
    inputTokens: 18,
    outputTokens: 7,
    totalTokens: 25,
    latestInputTokens: 15,
    contextWindow: 128_000,
    scope: 'session',
  });

  session = reduceSession(session, { type: 'session.cleared' }, { observedAt: 1_400 });
  assert.equal(session.tokenUsage, undefined);
  assert.equal(session.sessionTokenUsage, undefined);
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
        interactionId: 'review-1',
        schemaVersion: 2,
        view: { kind: 'plain', body: 'Approve?' },
        options: [{ id: 'approve', label: 'Approve', batchSubmission: 'defer' }],
      },
    },
  }, { observedAt: 1_100 });

  assert.equal(session.activeRun?.state, 'waiting_review');
  if (session.activeRun?.state !== 'waiting_review') assert.fail('expected waiting review');
  assert.equal(session.activeRun.reviewAction.actionId, 'request:req-1:reviews:review-1');
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
  assert.equal(session.activeRun?.state, 'running');
  assert.equal(session.activeRun?.state === 'running' ? session.activeRun.activity : null, 'thinking');
  assert.equal(session.activeRun && 'reviewAction' in session.activeRun, false);

  session = reduceSession(session, {
    type: 'run.interrupting',
    requestId: 'req-1',
  }, { observedAt: 1_300 });
  assert.equal(session.activeRun?.state, 'interrupting');
  assert.equal(session.activeRun && 'reviewAction' in session.activeRun, false);
});

test('run completion settles partial assistant output before its terminal notice', () => {
  let session = reduceSession(createDomainSession(), {
    type: 'user.accepted',
    requestId: 'req-interrupt',
    kind: 'chat',
    text: 'start a long task',
  }, { observedAt: 1_000 });
  session = reduceSession(session, {
    type: 'runtime.event',
    event: {
      type: 'message.delta',
      requestId: 'req-interrupt',
      messageId: 'm-req-interrupt',
      role: 'assistant',
      text: 'Partial output',
    },
  }, { observedAt: 1_100 });
  session = reduceSession(session, {
    type: 'run.finished',
    requestId: 'req-interrupt',
    messages: [{
      role: 'system',
      text: 'interrupted',
    }],
  }, { observedAt: 1_200 });

  assert.equal(session.activeRun, null);
  assert.deepEqual(
    session.timeline.map((entry) => (
      entry.type === 'message'
        ? `${entry.role}:${entry.status}:${entry.text}`
        : entry.type
    )),
    [
      'user:completed:start a long task',
      'assistant:completed:Partial output',
      'system:completed:interrupted',
    ],
  );
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
          type: 'subagent.message.completed',
          requestId: 'req-1',
          messageId: 'child-ephemeral',
          namespace: ['general:t1', 'model_request:t2'],
          text: 'ephemeral',
        },
      },
      observedAt: 1_700_000_000_100,
    },
  ]);
  const withUsage = {
    ...live,
    tokenUsage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    sessionTokenUsage: {
      inputTokens: 13,
      outputTokens: 7,
      totalTokens: 20,
      scope: 'session' as const,
    },
  };
  const snapshot = {
    version: AGENT_SESSION_SNAPSHOT_VERSION,
    session: {
      sessionId: 'chat:pet',
      kind: 'chat' as const,
      timeline: [{
        id: 'checkpoint:user:1',
        type: 'message' as const,
        role: 'user' as const,
        text: 'checkpoint message',
        status: 'completed' as const,
      }],
      activeRun: {
        requestId: 'req-1',
        state: 'running' as const,
        activity: 'thinking' as const,
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
  assert.deepEqual(completed.sessionTokenUsage, withUsage.sessionTokenUsage);

  const started = applySessionSnapshot(withUsage, snapshot, {
    observedAt: 1_700_000_000_200,
  });
  assert.equal(started.tokenUsage, undefined);
  assert.equal(started.sessionTokenUsage, undefined);

  const resumed = applySessionSnapshot(withUsage, snapshot, {
    observedAt: 1_700_000_000_200,
    preserveOmittedSessionTokenUsage: true,
  });
  assert.equal(resumed.tokenUsage, undefined);
  assert.deepEqual(resumed.sessionTokenUsage, withUsage.sessionTokenUsage);
});

test('a reply settled mid-run by a tool is finalized in place, not duplicated', () => {
  // The delegation shape that produced duplicated handoff/answer output: the
  // reply streams, a tool operation and a subagent handoff land, then the run
  // completes with that same text. Keying assistant entries by the upstream
  // message id makes the completion finalize the streamed entry directly.
  const inputs: Array<{ input: AgentSessionInput; observedAt: number }> = [
    {
      input: { type: 'user.accepted', requestId: 'req-1', kind: 'chat', text: 'go' },
      observedAt: 1_000,
    },
    {
      input: {
        type: 'runtime.event',
        event: {
          type: 'message.delta',
          requestId: 'req-1',
          messageId: 'ai-1',
          role: 'assistant',
          text: 'handed off result',
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
          phase: 'started',
          operation: { id: 'tool-1', kind: 'shell' },
        },
      },
      observedAt: 1_150,
    },
    {
      input: {
        type: 'runtime.event',
        event: {
          type: 'subagent.message.completed',
          requestId: 'req-1',
          messageId: 'child-1',
          namespace: ['general:t1'],
          text: 'handed off result',
        },
      },
      observedAt: 1_200,
    },
    {
      input: {
        type: 'runtime.event',
        event: {
          type: 'message.completed',
          requestId: 'req-1',
          messageId: 'ai-1',
          role: 'assistant',
          text: 'handed off result',
        },
      },
      observedAt: 1_400,
    },
  ];

  const session = replay(createDomainSession(), inputs);
  const assistants = session.timeline.filter((entry) =>
    entry.type === 'message' && entry.role === 'assistant');
  assert.equal(assistants.length, 1);
  assert.equal(assistants[0]?.id, 'req-1:assistant:ai-1');
  assert.equal(assistants[0]?.type === 'message' ? assistants[0].status : undefined, 'completed');
  // The subagent progress entry stays visible alongside the reply.
  assert.equal(
    session.timeline.filter((entry) => entry.type === 'message' && entry.role === 'subagent').length,
    1,
  );
});

test('text resuming after a tool becomes its own assistant entry', () => {
  const inputs: Array<{ input: AgentSessionInput; observedAt: number }> = [
    {
      input: { type: 'user.accepted', requestId: 'req-1', kind: 'chat', text: 'go' },
      observedAt: 1_000,
    },
    {
      input: {
        type: 'runtime.event',
        event: {
          type: 'message.delta',
          requestId: 'req-1',
          messageId: 'ai-1',
          role: 'assistant',
          text: 'let me check',
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
          phase: 'started',
          operation: { id: 'tool-1', kind: 'shell' },
        },
      },
      observedAt: 1_150,
    },
    {
      input: {
        type: 'runtime.event',
        event: {
          type: 'message.delta',
          requestId: 'req-1',
          messageId: 'ai-2',
          role: 'assistant',
          text: 'port is 3210',
        },
      },
      observedAt: 1_300,
    },
    {
      input: {
        type: 'runtime.event',
        event: {
          type: 'message.completed',
          requestId: 'req-1',
          messageId: 'ai-2',
          role: 'assistant',
          text: 'port is 3210',
        },
      },
      observedAt: 1_400,
    },
  ];

  const session = replay(createDomainSession(), inputs);
  const assistants = session.timeline.filter((entry): entry is Extract<AgentTimelineEntry, { type: 'message' }> =>
    entry.type === 'message' && entry.role === 'assistant');
  assert.equal(assistants.length, 2);
  // The pre-tool paragraph is not extended by post-tool text.
  assert.equal(assistants[0]?.text, 'let me check');
  assert.equal(assistants[1]?.text, 'port is 3210');
  assert.equal(assistants[0]?.status, 'completed');
});
