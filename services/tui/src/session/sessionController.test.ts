import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAgentSessionSnapshot,
} from '@pinpawo/agent-session';
import { TuiSessionController } from './sessionController';
import {
  eventMessage,
  FakeConnection,
  reviewSnapshotResult,
  reviewSpec,
  sessionSummary,
  snapshotResult,
} from './sessionControllerTestSupport';

test('TuiSessionController synchronizes one session and projects a chat run', () => {
  const requestIds = ['snapshot-1', 'chat-1', 'snapshot-2'];
  let connection!: FakeConnection;
  const controller = new TuiSessionController({
    connectionFactory: (handlers) => {
      connection = new FakeConnection(handlers);
      return connection;
    },
    requestIdFactory: () => requestIds.shift() ?? 'unexpected',
    now: () => 1_000,
    snapshotTimeoutMs: 60_000,
  });

  controller.start();
  assert.equal(controller.getState().connection, 'connecting');
  assert.equal(connection.connectCount, 1);

  connection.open();
  assert.deepEqual(connection.sent, [{
    type: 'session.snapshot.get',
    requestId: 'snapshot-1',
  }]);
  connection.receive({
    type: 'session.snapshot.result',
    requestId: 'snapshot-1',
    snapshot: createAgentSessionSnapshot({
      sessionId: 'chat:one',
      kind: 'chat',
      timeline: [],
      activeRun: null,
      runtime: {
        model: 'test-model',
        cwd: '/tmp/project',
        contextWindow: 128_000,
      },
    }),
  });

  assert.equal(controller.getState().connection, 'ready');
  assert.equal(controller.getState().session.sessionId, 'chat:one');
  assert.deepEqual(controller.submitChat('hello'), {
    ok: true,
    requestId: 'chat-1',
  });
  assert.deepEqual(connection.sent.at(-1), {
    type: 'chat_request',
    requestId: 'chat-1',
    message: 'hello',
    activeDelegationTransition: 'supersede_active',
  });
  assert.equal(controller.getState().session.timeline[0]?.type, 'message');
  assert.deepEqual(controller.getState().session.activeRun, {
    requestId: 'chat-1',
    state: 'running',
    activity: 'thinking',
    startedAt: 1_000,
    updatedAt: 1_000,
  });

  connection.receive(eventMessage({
    type: 'message.delta',
    requestId: 'chat-1',
    role: 'assistant',
    text: 'hi',
  }));
  const streaming = controller.getState().session.timeline[1];
  assert.equal(streaming?.type, 'message');
  assert.equal(streaming?.type === 'message' ? streaming.text : null, 'hi');

  connection.receive(eventMessage({
    type: 'message.completed',
    requestId: 'chat-1',
    role: 'assistant',
    text: 'hi there',
    usage: {
      inputTokens: 20,
      outputTokens: 5,
      totalTokens: 25,
      latestInputTokens: 20,
      contextWindow: 128_000,
    },
  }));
  assert.equal(controller.getState().session.activeRun, null);
  const completed = controller.getState().session.timeline[1];
  assert.equal(completed?.type === 'message' ? completed.text : null, 'hi there');
  assert.deepEqual(connection.sent.at(-1), {
    type: 'session.snapshot.get',
    requestId: 'snapshot-2',
  });

  connection.receive({
    type: 'session.snapshot.result',
    requestId: 'snapshot-2',
    snapshot: createAgentSessionSnapshot({
      sessionId: 'chat:one',
      kind: 'chat',
      timeline: [{
        id: 'message:0:user',
        type: 'message',
        role: 'user',
        text: 'hello',
        status: 'completed',
      }, {
        id: 'snapshot-message:1:assistant',
        type: 'message',
        role: 'assistant',
        text: 'authoritative reply',
        status: 'completed',
      }],
      activeRun: null,
      sessionTokenUsage: {
        inputTokens: 20,
        outputTokens: 5,
        totalTokens: 25,
        latestInputTokens: 20,
        contextWindow: 128_000,
        scope: 'session',
      },
    }),
  });
  assert.equal(controller.getState().session.sessionTokenUsage?.totalTokens, 25);
  assert.equal(controller.getState().session.timeline.length, 2);
  const reconciled = controller.getState().session.timeline[1];
  assert.equal(reconciled?.id, 'snapshot-message:1:assistant');
  assert.equal(
    reconciled?.type === 'message' ? reconciled.text : null,
    'authoritative reply',
  );
  controller.stop();
});

test('startup snapshot restores active run ownership for following activity events', () => {
  let connection!: FakeConnection;
  const controller = new TuiSessionController({
    connectionFactory: (handlers) => {
      connection = new FakeConnection(handlers);
      return connection;
    },
    requestIdFactory: () => 'snapshot-running',
    now: () => 1_000,
  });

  controller.start();
  connection.open();
  connection.receive({
    type: 'session.snapshot.result',
    requestId: 'snapshot-running',
    snapshot: createAgentSessionSnapshot({
      sessionId: 'chat:one',
      kind: 'chat',
      timeline: [],
      activeRun: {
        requestId: 'chat-running',
        state: 'running',
        activity: 'thinking',
        startedAt: 500,
      },
    }),
  });

  connection.receive(eventMessage({
    type: 'operation',
    requestId: 'chat-running',
    phase: 'started',
    operation: { id: 'tool-1', kind: 'shell', title: 'Run checks' },
  }));

  const session = controller.getState().session;
  assert.equal(session.timeline[0]?.type, 'operation');
  assert.equal(session.activeRun?.state, 'running');
  if (session.activeRun?.state === 'running') {
    assert.equal(session.activeRun.activity, 'using_tool');
  }
  controller.stop();
});

test('TuiSessionController submits local attachments and keeps paths out of optimistic text', () => {
  const requestIds = ['snapshot-1', 'chat-1'];
  let connection!: FakeConnection;
  const controller = new TuiSessionController({
    connectionFactory: (handlers) => {
      connection = new FakeConnection(handlers);
      return connection;
    },
    requestIdFactory: () => requestIds.shift() ?? 'unexpected',
  });
  controller.start();
  connection.open();
  connection.receive(snapshotResult('snapshot-1', 'chat:one'));

  assert.equal(controller.submitChat('', [{
    id: 'attachment-1',
    source: 'local-path',
    kind: 'file',
    path: '/Users/example/private/spec.md',
    name: 'spec.md',
  }]).ok, true);
  assert.deepEqual(connection.sent.at(-1), {
    type: 'chat_request',
    requestId: 'chat-1',
    message: '',
    attachments: [{
      id: 'attachment-1',
      source: 'local-path',
      kind: 'file',
      path: '/Users/example/private/spec.md',
      name: 'spec.md',
    }],
    activeDelegationTransition: 'supersede_active',
  });
  const optimistic = controller.getState().session.timeline[0];
  assert.equal(
    optimistic?.type === 'message' ? optimistic.text : null,
    'Attachments:\n- file: spec.md',
  );
  assert.doesNotMatch(
    optimistic?.type === 'message' ? optimistic.text : '',
    /Users\/example/,
  );
  controller.stop();
});

test('TuiSessionController updates review policy only after a correlated host acknowledgement', async () => {
  const requestIds = ['snapshot-1', 'policy-1', 'policy-2'];
  let connection!: FakeConnection;
  const controller = new TuiSessionController({
    connectionFactory: (handlers) => {
      connection = new FakeConnection(handlers);
      return connection;
    },
    requestIdFactory: () => requestIds.shift() ?? 'unexpected',
  });
  controller.start();
  connection.open();
  connection.receive({
    type: 'session.snapshot.result',
    requestId: 'snapshot-1',
    snapshot: createAgentSessionSnapshot({
      sessionId: 'chat:one',
      kind: 'chat',
      timeline: [],
      activeRun: null,
      runtime: {
        globalReviewPolicyMode: 'require_authorization',
      },
    }),
  });

  const update = controller.updateGlobalReviewPolicy('auto_authorization', 'relaxed');
  assert.deepEqual(connection.sent.at(-1), {
    type: 'runtime_config.update',
    requestId: 'policy-1',
    globalReviewPolicyMode: 'auto_authorization',
    autoAuthorizationSafetyLevel: 'relaxed',
  });
  assert.equal(
    controller.getState().session.runtime?.globalReviewPolicyMode,
    'require_authorization',
  );
  assert.deepEqual(controller.submitChat('must wait'), {
    ok: false,
    reason: 'busy',
  });

  connection.receive({
    type: 'runtime_config.result',
    requestId: 'policy-1',
    globalReviewPolicyMode: 'auto_authorization',
    autoAuthorizationSafetyLevel: 'relaxed',
  });
  assert.deepEqual(await update, {
    globalReviewPolicyMode: 'auto_authorization',
    autoAuthorizationSafetyLevel: 'relaxed',
  });
  assert.equal(
    controller.getState().session.runtime?.globalReviewPolicyMode,
    'auto_authorization',
  );
  assert.equal(
    controller.getState().session.runtime?.autoAuthorizationSafetyLevel,
    'relaxed',
  );

  const failed = controller.updateGlobalReviewPolicy('full_access', 'relaxed');
  connection.receive({
    type: 'runtime_config.error',
    requestId: 'policy-2',
    message: 'config is read-only',
  });
  await assert.rejects(failed, /config is read-only/);
  assert.equal(
    controller.getState().session.runtime?.globalReviewPolicyMode,
    'auto_authorization',
  );
  controller.stop();
});

test('TuiSessionController lists and switches session model profiles authoritatively', async () => {
  const requestIds = ['snapshot-1', 'model-list-1', 'model-select-1', 'model-select-2'];
  let connection!: FakeConnection;
  const controller = new TuiSessionController({
    connectionFactory: (handlers) => {
      connection = new FakeConnection(handlers);
      return connection;
    },
    requestIdFactory: () => requestIds.shift() ?? 'unexpected',
  });
  controller.start();
  connection.open();
  connection.receive({
    type: 'session.snapshot.result',
    requestId: 'snapshot-1',
    snapshot: createAgentSessionSnapshot({
      sessionId: 'chat:one',
      kind: 'chat',
      timeline: [],
      activeRun: null,
      runtime: {
        modelProfileId: 'text',
        modelProfileLabel: 'Text',
        requiredInputModalities: ['text', 'image'],
      },
    }),
  });

  const listed = controller.listModelProfiles();
  assert.deepEqual(connection.sent.at(-1), {
    type: 'model.list',
    requestId: 'model-list-1',
    sessionId: 'chat:one',
  });
  assert.deepEqual(controller.submitChat('must wait'), {
    ok: false,
    reason: 'busy',
  });
  connection.receive({
    type: 'model.list.result',
    requestId: 'model-list-1',
    sessionId: 'chat:one',
    defaultProfileId: 'text',
    selectedProfileId: 'text',
    requiredInputModalities: ['text', 'image'],
    profiles: [{
      id: 'text',
      label: 'Text',
      inputModalities: ['text'],
      available: true,
      compatible: false,
      issues: ['Session requires image input.'],
    }, {
      id: 'vision',
      label: 'Vision',
      inputModalities: ['text', 'image'],
      available: true,
      compatible: true,
      issues: [],
    }],
  });
  const modelList = await listed;
  assert.equal(modelList.profiles[0]?.compatible, false);

  const selected = controller.selectModelProfile('vision', 'chat:one');
  assert.deepEqual(connection.sent.at(-1), {
    type: 'model.select',
    requestId: 'model-select-1',
    sessionId: 'chat:one',
    modelProfileId: 'vision',
  });
  const snapshot = createAgentSessionSnapshot({
    sessionId: 'chat:one',
    kind: 'chat',
    timeline: [],
    activeRun: null,
    runtime: {
      modelProfileId: 'vision',
      modelProfileLabel: 'Vision',
      requiredInputModalities: ['text', 'image'],
    },
  });
  connection.receive({
    type: 'model.select.result',
    requestId: 'model-select-1',
    sessionId: 'chat:one',
    selectedProfileId: 'vision',
    snapshot,
  });
  assert.equal(await selected, snapshot);
  assert.equal(
    controller.getState().session.runtime?.modelProfileId,
    'vision',
  );

  const rejected = controller.selectModelProfile('text', 'chat:one');
  connection.receive({
    type: 'model.select.error',
    requestId: 'model-select-2',
    sessionId: 'chat:one',
    modelProfileId: 'text',
    code: 'profile_incompatible',
    message: 'Session requires image input.',
  });
  await assert.rejects(rejected, (error: Error & { code?: string }) => (
    error.message === 'Session requires image input.'
    && error.code === 'profile_incompatible'
  ));
  assert.equal(
    controller.getState().session.runtime?.modelProfileId,
    'vision',
  );
  controller.stop();
});

test('TuiSessionController records a Studio submission without projecting plugin events', () => {
  const requestIds = ['snapshot-1', 'studio-1', 'studio-2'];
  let connection!: FakeConnection;
  const controller = new TuiSessionController({
    connectionFactory: (handlers) => {
      connection = new FakeConnection(handlers);
      return connection;
    },
    requestIdFactory: () => requestIds.shift() ?? 'unexpected',
    now: () => 1_000,
  });
  controller.start();
  connection.open();
  connection.receive(snapshotResult('snapshot-1', 'chat:one'));

  assert.deepEqual(
    controller.submitStudio('  ship the release  ', 'studio:release'),
    { ok: true, requestId: 'studio-1' },
  );
  assert.deepEqual(connection.sent.at(-1), {
    type: 'studio_request',
    requestId: 'studio-1',
    userRequest: 'ship the release',
    conversationId: 'studio:release',
  });
  assert.equal(controller.getState().session.kind, 'studio');
  const userEntry = controller.getState().session.timeline[0];
  assert.equal(
    userEntry?.type === 'message' ? userEntry.text : null,
    '[studio] ship the release',
  );

  // 推模型:提交即返回,回执不含 pet 的答复(那时还没有产出)。
  connection.receive({
    type: 'studio_response',
    requestId: 'studio-1',
    outcome: 'done',
    reply: '',
  });
  assert.equal(controller.getState().session.activeRun, null);
  assert.deepEqual(
    controller.getState().session.timeline
      .filter((entry) => entry.type === 'message')
      .map((entry) => entry.text),
    [
      '[studio] ship the release',
      '[studio] 已提交',
    ],
  );

  // 插件 event 之后才到,且不再投影进这条会话 —— 进度归插件自己的视图。
  connection.receive(eventMessage({
    type: 'studio.progress',
    requestId: 'studio-1',
    event: { type: 'task.done', source: 'kanban' },
  }));
  assert.equal(controller.getState().session.timeline.length, 2);

  assert.equal(
    controller.submitStudio('retry', 'studio:release').ok,
    true,
  );
  connection.receive({
    type: 'studio_error',
    requestId: 'studio-2',
    message: 'Studio is not configured',
  });
  assert.equal(controller.getState().session.activeRun, null);
  const errorEntry = controller.getState().session.timeline.at(-1);
  assert.equal(
    errorEntry?.type === 'message' ? errorEntry.text : null,
    '[studio error] Studio is not configured',
  );
  controller.stop();
});

test('interrupting a running session is optimistic and idempotent', () => {
  const requestIds = ['startup', 'chat'];
  let connection!: FakeConnection;
  const controller = new TuiSessionController({
    connectionFactory: (handlers) => {
      connection = new FakeConnection(handlers);
      return connection;
    },
    requestIdFactory: () => requestIds.shift() ?? 'unexpected',
  });
  controller.start();
  connection.open();
  connection.receive(snapshotResult('startup', 'chat:one'));
  assert.equal(controller.submitChat('long task').ok, true);

  assert.deepEqual(controller.interruptRun(), {
    ok: true,
    requestId: 'chat',
  });
  assert.deepEqual(connection.sent.at(-1), {
    type: 'run.interrupt',
    requestId: 'chat',
  });
  assert.equal(controller.getState().session.activeRun?.state, 'interrupting');
  assert.deepEqual(controller.interruptRun(), {
    ok: false,
    reason: 'already-interrupting',
  });

  connection.receive({
    type: 'interrupted',
    requestId: 'chat',
    message: 'stopped by user',
  });
  assert.equal(controller.getState().session.activeRun, null);
  const terminal = controller.getState().session.timeline.at(-1);
  assert.equal(
    terminal?.type === 'message' ? terminal.text : null,
    'stopped by user',
  );
  controller.stop();
});

test('starting a new session applies the authoritative snapshot and ignores an older completion snapshot', async () => {
  const requestIds = ['startup', 'completion', 'new-session'];
  let connection!: FakeConnection;
  const controller = new TuiSessionController({
    connectionFactory: (handlers) => {
      connection = new FakeConnection(handlers);
      return connection;
    },
    requestIdFactory: () => requestIds.shift() ?? 'unexpected',
    now: () => 1_000,
  });
  controller.start();
  connection.open();
  connection.receive({
    type: 'session.snapshot.result',
    requestId: 'startup',
    snapshot: createAgentSessionSnapshot({
      sessionId: 'chat:old',
      kind: 'chat',
      timeline: [{
        id: 'old-message',
        type: 'message',
        role: 'assistant',
        text: 'old response',
        status: 'completed',
      }],
      activeRun: null,
      sessionTokenUsage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        scope: 'session',
      },
    }),
  });
  connection.receive(eventMessage({
    type: 'message.completed',
    requestId: 'old-run',
    role: 'assistant',
    text: 'late completion',
  }));
  assert.deepEqual(connection.sent.at(-1), {
    type: 'session.snapshot.get',
    requestId: 'completion',
  });

  const started = controller.startNewSession();
  assert.deepEqual(connection.sent.at(-1), {
    type: 'session.new',
    requestId: 'new-session',
  });
  assert.equal(controller.getState().session.sessionId, 'chat:old');
  assert.notEqual(controller.getState().session.timeline.length, 0);

  const newSnapshot = createAgentSessionSnapshot({
    sessionId: 'chat:new',
    kind: 'chat',
    timeline: [],
    activeRun: null,
  });
  connection.receive({
    type: 'session.new.result',
    requestId: 'new-session',
    session: {
      id: 'chat:new',
      kind: 'chat',
      title: 'New session',
      messageCount: 0,
      createdAt: '2026-07-27T01:00:00.000Z',
      updatedAt: '2026-07-27T01:00:00.000Z',
      active: true,
    },
    snapshot: newSnapshot,
  });
  assert.equal((await started).snapshot.session.sessionId, 'chat:new');
  assert.equal(controller.getState().session.sessionId, 'chat:new');
  assert.equal(controller.getState().session.timeline.length, 0);
  assert.equal(controller.getState().session.sessionTokenUsage, undefined);

  connection.receive({
    type: 'session.snapshot.result',
    requestId: 'completion',
    snapshot: createAgentSessionSnapshot({
      sessionId: 'chat:old',
      kind: 'chat',
      timeline: [{
        id: 'late-old-message',
        type: 'message',
        role: 'assistant',
        text: 'must not return',
        status: 'completed',
      }],
      activeRun: null,
    }),
  });
  assert.equal(controller.getState().session.timeline.length, 0);
  controller.stop();
});

test('starting a new session rejects unavailable and busy states', async () => {
  let connection!: FakeConnection;
  const controller = new TuiSessionController({
    connectionFactory: (handlers) => {
      connection = new FakeConnection(handlers);
      return connection;
    },
    requestIdFactory: () => 'request',
  });
  await assert.rejects(
    controller.startNewSession(),
    /local-agent is not connected/,
  );
  controller.start();
  connection.open();
  connection.receive(snapshotResult('request', 'chat:one'));
  assert.equal(controller.submitChat('busy').ok, true);
  await assert.rejects(
    controller.startNewSession(),
    /wait for the current response to finish/,
  );
  controller.stop();
});

test('TuiSessionController reconnects and rehydrates before becoming ready', () => {
  const timers: Array<{ callback: () => void; handle: ReturnType<typeof setTimeout> }> = [];
  let connection!: FakeConnection;
  let requestIndex = 0;
  const controller = new TuiSessionController({
    connectionFactory: (handlers) => {
      connection = new FakeConnection(handlers);
      return connection;
    },
    requestIdFactory: () => `request-${requestIndex += 1}`,
    reconnectDelaysMs: [25],
    setTimer: (callback) => {
      const handle = {} as ReturnType<typeof setTimeout>;
      timers.push({ callback, handle });
      return handle;
    },
    clearTimer: (handle) => {
      const index = timers.findIndex((timer) => timer.handle === handle);
      if (index >= 0) timers.splice(index, 1);
    },
  });

  controller.start();
  connection.open();
  const startupRequest = connection.sent.at(-1);
  assert.equal(startupRequest?.type, 'session.snapshot.get');
  connection.receive(snapshotResult(startupRequest?.requestId ?? '', 'chat:one'));
  assert.equal(controller.getState().connection, 'ready');

  connection.handlers.onError(new Error('protocol mismatch'));
  assert.equal(controller.getState().connection, 'error');
  assert.equal(controller.getState().connectionDetail, 'protocol mismatch');
  connection.close();
  assert.equal(controller.getState().connection, 'reconnecting');
  assert.match(controller.getState().connectionDetail ?? '', /retrying in 25ms/);
  assert.equal(timers.length, 1);

  timers.shift()?.callback();
  assert.equal(connection.connectCount, 2);
  connection.open();
  const reconnectRequest = connection.sent.at(-1);
  assert.equal(reconnectRequest?.type, 'session.snapshot.get');
  assert.equal(controller.getState().connection, 'reconnecting');
  connection.receive(snapshotResult(reconnectRequest?.requestId ?? '', 'chat:one'));
  assert.equal(controller.getState().connection, 'ready');
  controller.stop();
});

test('TuiSessionController keeps retrying at the capped delay until the host returns', () => {
  const timers: Array<{
    callback: () => void;
    delayMs: number;
    handle: ReturnType<typeof setTimeout>;
  }> = [];
  let connection!: FakeConnection;
  const controller = new TuiSessionController({
    connectionFactory: (handlers) => {
      connection = new FakeConnection(handlers);
      return connection;
    },
    reconnectDelaysMs: [10, 25],
    setTimer: (callback, delayMs) => {
      const handle = {} as ReturnType<typeof setTimeout>;
      timers.push({ callback, delayMs, handle });
      return handle;
    },
    clearTimer: (handle) => {
      const index = timers.findIndex((timer) => timer.handle === handle);
      if (index >= 0) timers.splice(index, 1);
    },
  });

  controller.start();
  connection.close();
  assert.equal(timers[0]?.delayMs, 10);
  assert.match(controller.getState().connectionDetail ?? '', /1\/2/);

  timers.shift()?.callback();
  assert.equal(connection.connectCount, 2);
  connection.close();
  assert.equal(timers[0]?.delayMs, 25);
  assert.match(controller.getState().connectionDetail ?? '', /2\/2/);

  timers.shift()?.callback();
  assert.equal(connection.connectCount, 3);
  connection.close();
  assert.equal(timers[0]?.delayMs, 25);
  assert.match(
    controller.getState().connectionDetail ?? '',
    /background attempt 3/,
  );

  timers.shift()?.callback();
  assert.equal(connection.connectCount, 4);
  connection.open();
  const snapshotRequest = connection.sent.at(-1);
  assert.equal(snapshotRequest?.type, 'session.snapshot.get');
  connection.receive(snapshotResult(
    snapshotRequest?.requestId ?? '',
    'chat:recovered',
  ));
  assert.equal(controller.getState().connection, 'ready');
  assert.equal(controller.getState().session.sessionId, 'chat:recovered');
  assert.equal(timers.length, 0);
  controller.stop();
});

test('completion snapshot refresh cannot erase a newer optimistic run', () => {
  const requestIds = ['startup', 'first', 'completion', 'second'];
  let connection!: FakeConnection;
  const controller = new TuiSessionController({
    connectionFactory: (handlers) => {
      connection = new FakeConnection(handlers);
      return connection;
    },
    requestIdFactory: () => requestIds.shift() ?? 'unexpected',
    now: () => 1_000,
  });
  controller.start();
  connection.open();
  connection.receive(snapshotResult('startup', 'chat:one'));
  assert.equal(controller.submitChat('first').ok, true);
  connection.receive(eventMessage({
    type: 'message.completed',
    requestId: 'first',
    role: 'assistant',
    text: 'first reply',
  }));
  assert.equal(controller.submitChat('second').ok, true);

  connection.receive({
    type: 'session.snapshot.result',
    requestId: 'completion',
    snapshot: createAgentSessionSnapshot({
      sessionId: 'chat:one',
      kind: 'chat',
      timeline: [{
        id: 'message:0:user',
        type: 'message',
        role: 'user',
        text: 'first',
        status: 'completed',
      }, {
        id: 'message:1:assistant',
        type: 'message',
        role: 'assistant',
        text: 'first reply',
        status: 'completed',
      }],
      activeRun: null,
      sessionTokenUsage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        scope: 'session',
      },
    }),
  });

  assert.equal(controller.getState().session.activeRun?.requestId, 'second');
  const latest = controller.getState().session.timeline.at(-1);
  assert.equal(latest?.type === 'message' ? latest.text : null, 'second');
  assert.equal(controller.getState().session.sessionTokenUsage?.totalTokens, 15);
  controller.stop();
});

test('production controller keeps high-frequency deltas interleaved with operations and subagents', () => {
  const requestIds = ['startup', 'chat', 'completion'];
  let connection!: FakeConnection;
  const controller = new TuiSessionController({
    connectionFactory: (handlers) => {
      connection = new FakeConnection(handlers);
      return connection;
    },
    requestIdFactory: () => requestIds.shift() ?? 'unexpected',
    now: () => 1_000,
  });
  controller.start();
  connection.open();
  connection.receive(snapshotResult('startup', 'chat:one'));
  assert.equal(controller.submitChat('inspect').ok, true);

  connection.receive(eventMessage({
    type: 'operation',
    requestId: 'chat',
    phase: 'started',
    operation: {
      id: 'operation-1',
      kind: 'test',
      title: 'Read file',
    },
  }));
  connection.receive(eventMessage({
    type: 'subagent.message.completed',
    requestId: 'chat',
    messageId: 'subagent-1',
    namespace: ['explore'],
    text: 'found evidence',
  }));
  connection.receive(eventMessage({
    type: 'operation',
    requestId: 'chat',
    phase: 'completed',
    operation: {
      id: 'operation-1',
      kind: 'test',
      title: 'Read file',
      summary: 'done',
    },
  }));

  for (let index = 0; index < 1_000; index += 1) {
    connection.receive(eventMessage({
      type: 'message.delta',
      requestId: 'chat',
      role: 'assistant',
      text: String(index % 10),
    }));
  }
  connection.receive(eventMessage({
    type: 'message.completed',
    requestId: 'chat',
    role: 'assistant',
    text: 'final answer',
  }));

  const timeline = controller.getState().session.timeline;
  assert.deepEqual(timeline.map((entry) => (
    entry.type === 'operation'
      ? `operation:${entry.phase}`
      : `message:${entry.role}:${entry.status}`
  )), [
    'message:user:completed',
    'operation:completed',
    'message:subagent:completed',
    'message:assistant:completed',
  ]);
  const completed = timeline.at(-1);
  assert.equal(
    completed?.type === 'message'
      ? completed.text
      : null,
    'final answer',
  );
  controller.stop();
});

test('TuiSessionController lists resumable sessions and applies the selected snapshot', async () => {
  const requestIds = ['startup', 'list', 'resume'];
  let connection!: FakeConnection;
  const controller = new TuiSessionController({
    connectionFactory: (handlers) => {
      connection = new FakeConnection(handlers);
      return connection;
    },
    requestIdFactory: () => requestIds.shift() ?? 'unexpected',
    now: () => 2_000,
  });
  controller.start();
  connection.open();
  connection.receive(snapshotResult('startup', 'chat:one'));

  const listPromise = controller.listSessions();
  assert.deepEqual(connection.sent.at(-1), {
    type: 'session.list',
    requestId: 'list',
  });
  const listedSession = sessionSummary('chat:two', false);
  connection.receive({
    type: 'session.list.result',
    requestId: 'list',
    sessions: [listedSession],
  });
  assert.deepEqual(await listPromise, [listedSession]);

  const resumePromise = controller.resumeSession('chat:two');
  assert.deepEqual(connection.sent.at(-1), {
    type: 'session.resume',
    requestId: 'resume',
    sessionId: 'chat:two',
  });
  const snapshot = createAgentSessionSnapshot({
    sessionId: 'chat:two',
    kind: 'chat',
    timeline: [{
      id: 'resumed-message',
      type: 'message',
      role: 'assistant',
      text: 'restored',
      status: 'completed',
    }],
    activeRun: null,
  });
  connection.receive({
    type: 'session.resume.result',
    requestId: 'resume',
    session: listedSession,
    snapshot,
  });

  assert.deepEqual(await resumePromise, {
    session: listedSession,
    snapshot,
  });
  assert.equal(controller.getState().session.sessionId, 'chat:two');
  assert.equal(controller.getState().session.timeline[0]?.id, 'resumed-message');
  controller.stop();
});

test('resuming clears an older completion snapshot request', async () => {
  const requestIds = ['startup', 'chat', 'completion', 'resume'];
  let connection!: FakeConnection;
  const controller = new TuiSessionController({
    connectionFactory: (handlers) => {
      connection = new FakeConnection(handlers);
      return connection;
    },
    requestIdFactory: () => requestIds.shift() ?? 'unexpected',
  });
  controller.start();
  connection.open();
  connection.receive(snapshotResult('startup', 'chat:one'));
  assert.equal(controller.submitChat('finish this').ok, true);
  connection.receive(eventMessage({
    type: 'message.completed',
    requestId: 'chat',
    role: 'assistant',
    text: 'done',
  }));
  assert.deepEqual(connection.sent.at(-1), {
    type: 'session.snapshot.get',
    requestId: 'completion',
  });

  const resumePromise = controller.resumeSession('chat:two');
  const resumedSummary = sessionSummary('chat:two', false);
  connection.receive({
    type: 'session.resume.result',
    requestId: 'resume',
    session: resumedSummary,
    snapshot: createAgentSessionSnapshot({
      sessionId: 'chat:two',
      kind: 'chat',
      timeline: [],
      activeRun: null,
    }),
  });
  await resumePromise;

  connection.receive(snapshotResult('completion', 'chat:one'));
  assert.equal(controller.getState().session.sessionId, 'chat:two');
  controller.stop();
});

test('resume rejects a response whose snapshot belongs to another session', async () => {
  const requestIds = ['startup', 'resume'];
  let connection!: FakeConnection;
  const controller = new TuiSessionController({
    connectionFactory: (handlers) => {
      connection = new FakeConnection(handlers);
      return connection;
    },
    requestIdFactory: () => requestIds.shift() ?? 'unexpected',
  });
  controller.start();
  connection.open();
  connection.receive(snapshotResult('startup', 'chat:one'));

  const resumePromise = controller.resumeSession('chat:two');
  connection.receive({
    type: 'session.resume.result',
    requestId: 'resume',
    session: sessionSummary('chat:two', false),
    snapshot: createAgentSessionSnapshot({
      sessionId: 'chat:wrong',
      kind: 'chat',
      timeline: [],
      activeRun: null,
    }),
  });
  await assert.rejects(resumePromise, /did not match/);
  assert.equal(controller.getState().session.sessionId, 'chat:one');
  controller.stop();
});

test('session commands reject protocol errors, busy runs, and timeouts', async () => {
  const timers: Array<{ callback: () => void; handle: ReturnType<typeof setTimeout> }> = [];
  const requestIds = ['startup', 'list-error', 'chat', 'list-timeout'];
  let connection!: FakeConnection;
  const controller = new TuiSessionController({
    connectionFactory: (handlers) => {
      connection = new FakeConnection(handlers);
      return connection;
    },
    requestIdFactory: () => requestIds.shift() ?? 'unexpected',
    sessionCommandTimeoutMs: 25,
    setTimer: (callback) => {
      const handle = {} as ReturnType<typeof setTimeout>;
      timers.push({ callback, handle });
      return handle;
    },
    clearTimer: (handle) => {
      const index = timers.findIndex((timer) => timer.handle === handle);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  controller.start();
  connection.open();
  connection.receive(snapshotResult('startup', 'chat:one'));

  const failedList = controller.listSessions();
  connection.receive({
    type: 'session.error',
    requestId: 'list-error',
    operation: 'list',
    message: 'list unavailable',
  });
  await assert.rejects(failedList, /list unavailable/);

  assert.equal(controller.submitChat('busy').ok, true);
  await assert.rejects(
    controller.listSessions(),
    /wait for the current response to finish/,
  );
  connection.receive(eventMessage({
    type: 'message.completed',
    requestId: 'chat',
    role: 'assistant',
    text: 'done',
  }));
  const completionRequest = connection.sent.at(-1);
  if (completionRequest?.type === 'session.snapshot.get') {
    connection.receive(snapshotResult(completionRequest.requestId, 'chat:one'));
  }

  const timedOutList = controller.listSessions();
  assert.equal(timers.length, 1);
  timers[0]?.callback();
  await assert.rejects(timedOutList, /session list request timed out/);
  controller.stop();
});

test('manual compaction binds the active session and uses its model-call timeout', async () => {
  const timers: Array<{
    callback: () => void;
    delay: number;
    handle: ReturnType<typeof setTimeout>;
  }> = [];
  const requestIds = ['startup', 'compact', 'compact-error'];
  let connection!: FakeConnection;
  const controller = new TuiSessionController({
    connectionFactory: (handlers) => {
      connection = new FakeConnection(handlers);
      return connection;
    },
    requestIdFactory: () => requestIds.shift() ?? 'unexpected',
    sessionCommandTimeoutMs: 25,
    sessionCompactTimeoutMs: 120_000,
    setTimer: (callback, delay) => {
      const handle = {} as ReturnType<typeof setTimeout>;
      timers.push({ callback, delay, handle });
      return handle;
    },
    clearTimer: (handle) => {
      const index = timers.findIndex((timer) => timer.handle === handle);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  controller.start();
  connection.open();
  connection.receive(snapshotResult('startup', 'chat:one'));

  const compacted = controller.compactSession();
  assert.equal(controller.getState().pendingSessionCommand, 'compact');
  assert.deepEqual(connection.sent.at(-1), {
    type: 'session.compact',
    requestId: 'compact',
    sessionId: 'chat:one',
  });
  assert.equal(timers.length, 1);
  assert.equal(timers[0]?.delay, 120_000);

  connection.receive({
    type: 'session.compact.result',
    requestId: 'compact',
    compacted: true,
    snapshot: createAgentSessionSnapshot({
      sessionId: 'chat:one',
      kind: 'chat',
      timeline: [],
      activeRun: null,
    }),
  });
  assert.equal((await compacted).compacted, true);
  assert.equal(controller.getState().pendingSessionCommand, undefined);
  assert.equal(controller.getState().session.sessionId, 'chat:one');

  const failedCompaction = controller.compactSession();
  assert.equal(controller.getState().pendingSessionCommand, 'compact');
  connection.receive({
    type: 'session.error',
    requestId: 'compact-error',
    operation: 'compact',
    message: 'summary model unavailable',
  });
  await assert.rejects(failedCompaction, /summary model unavailable/);
  assert.equal(controller.getState().pendingSessionCommand, undefined);
  controller.stop();
});

test('delegation continuation sends resume_active without client-owned availability', async () => {
  const requestIds = [
    'startup',
    'interrupted-refresh',
    'resume-other',
    'resume-original',
    'continue-failed',
    'continue-sent',
    'continue-refresh',
  ];
  let connection!: FakeConnection;
  const controller = new TuiSessionController({
    connectionFactory: (handlers) => {
      connection = new FakeConnection(handlers);
      return connection;
    },
    requestIdFactory: () => requestIds.shift() ?? 'unexpected',
  });
  controller.start();
  connection.open();
  connection.receive(reviewSnapshotResult('startup', [
    reviewSpec('review-1', [{
      id: 'approve',
      label: 'Approve',
      batchSubmission: 'immediate',
    }]),
  ]));

  assert.deepEqual(controller.cancelReview({
    requestId: 'chat',
    actionId: 'review-action',
  }), { ok: true });
  connection.receive({
    type: 'interrupted',
    requestId: 'chat',
    message: 'review interrupted',
  });
  assert.deepEqual(connection.sent.at(-1), {
    type: 'session.snapshot.get',
    requestId: 'interrupted-refresh',
  });
  connection.receive({
    type: 'session.snapshot.result',
    requestId: 'interrupted-refresh',
    snapshot: createAgentSessionSnapshot({
      sessionId: 'chat:one',
      kind: 'chat',
      timeline: [],
      activeRun: null,
    }),
  });

  const resumeOther = controller.resumeSession('chat:two');
  connection.receive({
    type: 'session.resume.result',
    requestId: 'resume-other',
    session: sessionSummary('chat:two', true),
    snapshot: createAgentSessionSnapshot({
      sessionId: 'chat:two',
      kind: 'chat',
      timeline: [],
      activeRun: null,
    }),
  });
  await resumeOther;

  const resumeOriginal = controller.resumeSession('chat:one');
  connection.receive({
    type: 'session.resume.result',
    requestId: 'resume-original',
    session: sessionSummary('chat:one', true),
    snapshot: createAgentSessionSnapshot({
      sessionId: 'chat:one',
      kind: 'chat',
      timeline: [],
      activeRun: null,
    }),
  });
  await resumeOriginal;

  connection.failNextSend = true;
  assert.deepEqual(
    controller.continueActiveDelegation('apply the new constraints'),
    { ok: false, reason: 'send-failed' },
  );

  assert.deepEqual(
    controller.continueActiveDelegation('apply the new constraints'),
    { ok: true, requestId: 'continue-sent' },
  );
  assert.deepEqual(connection.sent.at(-1), {
    type: 'chat_request',
    requestId: 'continue-sent',
    message: 'apply the new constraints',
    activeDelegationTransition: 'resume_active',
  });
  assert.deepEqual(
    controller.continueActiveDelegation('cannot overlap the active run'),
    { ok: false, reason: 'busy' },
  );
  connection.receive(eventMessage({
    type: 'message.completed',
    requestId: 'continue-sent',
    role: 'assistant',
    text: 'continued',
  }));
  assert.deepEqual(connection.sent.at(-1), {
    type: 'session.snapshot.get',
    requestId: 'continue-refresh',
  });
  connection.receive({
    type: 'session.snapshot.result',
    requestId: 'continue-refresh',
    snapshot: createAgentSessionSnapshot({
      sessionId: 'chat:one',
      kind: 'chat',
      timeline: [],
      activeRun: null,
    }),
  });
  controller.stop();
});
