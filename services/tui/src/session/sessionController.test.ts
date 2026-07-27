import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAgentSessionSnapshot,
  type AgentClientMessage,
  type AgentServerMessage,
} from '@pinpawo/agent-session';
import type {
  AgentHostConnection as TuiAgentHostConnection,
  LocalHostConnectionHandlers,
} from '../client/localHostConnection';
import { TuiSessionController } from './sessionController';

class FakeConnection implements TuiAgentHostConnection {
  connected = false;
  connectCount = 0;
  sent: AgentClientMessage[] = [];

  constructor(readonly handlers: LocalHostConnectionHandlers) {}

  connect() {
    this.connectCount += 1;
  }

  disconnect() {
    this.connected = false;
  }

  send(message: AgentClientMessage) {
    if (!this.connected) return false;
    this.sent.push(message);
    return true;
  }

  isConnected() {
    return this.connected;
  }

  open() {
    this.connected = true;
    this.handlers.onOpen();
  }

  receive(message: AgentServerMessage) {
    this.handlers.onMessage(message);
  }

  close() {
    this.connected = false;
    this.handlers.onClose();
  }
}

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
  });
  assert.equal(controller.getState().session.timeline[0]?.type, 'message');
  assert.equal(controller.getState().session.activeRun?.requestId, 'chat-1');

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
        id: 'message:1:assistant',
        type: 'message',
        role: 'assistant',
        text: 'hi there',
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

  const update = controller.updateGlobalReviewPolicy('auto_authorization');
  assert.deepEqual(connection.sent.at(-1), {
    type: 'runtime_config.update',
    requestId: 'policy-1',
    globalReviewPolicyMode: 'auto_authorization',
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
  });
  assert.deepEqual(await update, {
    globalReviewPolicyMode: 'auto_authorization',
  });
  assert.equal(
    controller.getState().session.runtime?.globalReviewPolicyMode,
    'auto_authorization',
  );

  const failed = controller.updateGlobalReviewPolicy('full_access');
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

test('TuiSessionController projects Studio progress and terminal responses', () => {
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

  connection.receive(eventMessage({
    type: 'studio.progress',
    requestId: 'studio-1',
    event: {
      type: 'tasks_queued',
      taskCount: 3,
    },
  }));
  const progressEntry = controller.getState().session.timeline.at(-1);
  assert.equal(
    progressEntry?.type === 'message' ? progressEntry.text : null,
    '[studio] queued 3 tasks',
  );

  connection.receive({
    type: 'studio_response',
    requestId: 'studio-1',
    outcome: 'stopped',
    reply: 'Prepared two tasks.',
    reason: 'waiting for input',
  });
  assert.equal(controller.getState().session.activeRun, null);
  assert.deepEqual(
    controller.getState().session.timeline
      .filter((entry) => entry.type === 'message')
      .map((entry) => entry.text),
    [
      '[studio] ship the release',
      '[studio] queued 3 tasks',
      'Prepared two tasks.',
      '[studio] stopped: waiting for input',
    ],
  );
  connection.receive(eventMessage({
    type: 'studio.progress',
    requestId: 'studio-1',
    event: {
      type: 'task_finished',
      petRunId: 'late-run',
      status: 'done',
    },
  }));
  assert.equal(controller.getState().session.timeline.length, 4);

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

test('review responses advance approved batches and send the final canonical decisions', () => {
  let connection!: FakeConnection;
  const controller = new TuiSessionController({
    connectionFactory: (handlers) => {
      connection = new FakeConnection(handlers);
      return connection;
    },
    requestIdFactory: () => 'startup',
  });
  controller.start();
  connection.open();
  connection.receive(reviewSnapshotResult('startup', [
    reviewSpec('review-1', [{
      id: 'approve-1',
      label: 'Approve first',
      decision: { type: 'approve' },
    }]),
    reviewSpec('review-2', [{
      id: 'approve-2',
      label: 'Approve second',
      decision: { type: 'approve' },
    }]),
  ]));

  const first = controller.submitReviewResponse({
    requestId: 'chat',
    actionId: 'review-action',
    decisions: [],
    optionId: 'approve-1',
  });
  assert.equal(first.ok, true);
  assert.equal(first.ok ? first.status : null, 'advanced');
  assert.equal(connection.sent.length, 1);

  const second = controller.submitReviewResponse({
    requestId: 'chat',
    actionId: 'review-action',
    decisions: first.ok ? first.decisions : [],
    optionId: 'approve-2',
  });
  assert.equal(second.ok, true);
  assert.equal(second.ok ? second.status : null, 'sent');
  assert.deepEqual(connection.sent.at(-1), {
    type: 'human_review_response',
    requestId: 'chat',
    actionId: 'review-action',
    reviewId: 'review-2',
    selectedOptionId: 'approve-2',
    decisions: [{
      reviewId: 'review-1',
      selectedOptionId: 'approve-1',
    }, {
      reviewId: 'review-2',
      selectedOptionId: 'approve-2',
    }],
  });
  controller.stop();
});

test('review responses validate free text and reject stale local drafts', () => {
  let connection!: FakeConnection;
  const controller = new TuiSessionController({
    connectionFactory: (handlers) => {
      connection = new FakeConnection(handlers);
      return connection;
    },
    requestIdFactory: () => 'startup',
  });
  controller.start();
  connection.open();
  connection.receive(reviewSnapshotResult('startup', [
    reviewSpec('review-1', [{
      id: 'respond',
      label: 'Respond',
      input: {
        kind: 'text',
        key: 'message',
        required: true,
        multiline: true,
      },
      decision: {
        type: 'respond',
        messageInputKey: 'message',
      },
    }]),
  ]));

  assert.deepEqual(controller.submitReviewResponse({
    requestId: 'chat',
    actionId: 'review-action',
    decisions: [],
    optionId: 'respond',
    inputText: '   ',
  }), {
    ok: false,
    reason: 'input-required',
  });
  assert.deepEqual(controller.submitReviewResponse({
    requestId: 'chat',
    actionId: 'review-action',
    decisions: [{
      reviewId: 'wrong-review',
      selectedOptionId: 'respond',
    }],
    optionId: 'respond',
    inputText: 'ship it',
  }), {
    ok: false,
    reason: 'stale',
  });

  const result = controller.submitReviewResponse({
    requestId: 'chat',
    actionId: 'review-action',
    decisions: [],
    optionId: 'respond',
    inputText: '  needs changes  ',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(connection.sent.at(-1), {
    type: 'human_review_response',
    requestId: 'chat',
    actionId: 'review-action',
    reviewId: 'review-1',
    selectedOptionId: 'respond',
    input: { message: 'needs changes' },
    decisions: [{
      reviewId: 'review-1',
      selectedOptionId: 'respond',
      input: { message: 'needs changes' },
    }],
  });
  controller.stop();
});

test('review cancellation targets only the current canonical action', () => {
  let connection!: FakeConnection;
  const controller = new TuiSessionController({
    connectionFactory: (handlers) => {
      connection = new FakeConnection(handlers);
      return connection;
    },
    requestIdFactory: () => 'startup',
  });
  controller.start();
  connection.open();
  connection.receive(reviewSnapshotResult('startup', [
    reviewSpec('review-1', [{
      id: 'approve',
      label: 'Approve',
      decision: { type: 'approve' },
    }]),
  ]));

  assert.deepEqual(controller.cancelReview({
    requestId: 'other',
    actionId: 'review-action',
  }), {
    ok: false,
    reason: 'stale',
  });
  assert.deepEqual(controller.cancelReview({
    requestId: 'chat',
    actionId: 'review-action',
  }), {
    ok: true,
  });
  assert.deepEqual(connection.sent.at(-1), {
    type: 'review.cancel',
    requestId: 'chat',
    actionId: 'review-action',
  });
  controller.stop();
});

function eventMessage(
  event: Extract<AgentServerMessage, { type: 'event' }>['event'],
): AgentServerMessage {
  return {
    type: 'event',
    requestId: event.requestId,
    event,
  };
}

function sessionSummary(
  id: string,
  active: boolean,
) {
  return {
    id,
    kind: 'chat' as const,
    title: `Session ${id}`,
    messageCount: 2,
    createdAt: '2026-07-27T01:00:00.000Z',
    updatedAt: '2026-07-27T02:00:00.000Z',
    active,
  };
}

function reviewSnapshotResult(
  requestId: string,
  reviews: NonNullable<
    Extract<
      ReturnType<TuiSessionController['getState']>['session']['activeRun'],
      { state: 'waiting_review' }
    >
  >['reviewAction']['reviews'],
): AgentServerMessage {
  return {
    type: 'session.snapshot.result',
    requestId,
    snapshot: createAgentSessionSnapshot({
      sessionId: 'chat:one',
      kind: 'chat',
      timeline: [],
      activeRun: {
        requestId: 'chat',
        state: 'waiting_review',
        reviewAction: {
          actionId: 'review-action',
          reviews,
        },
      },
    }),
  };
}

function reviewSpec(
  id: string,
  options: NonNullable<
    Extract<
      ReturnType<TuiSessionController['getState']>['session']['activeRun'],
      { state: 'waiting_review' }
    >
  >['reviewAction']['reviews'][number]['options'],
) {
  return {
    id,
    schemaVersion: 1,
    view: {
      kind: 'plain' as const,
      body: `Review ${id}`,
    },
    options,
  };
}

function snapshotResult(requestId: string, sessionId: string): AgentServerMessage {
  return {
    type: 'session.snapshot.result',
    requestId,
    snapshot: createAgentSessionSnapshot({
      sessionId,
      kind: 'chat',
      timeline: [],
      activeRun: null,
    }),
  };
}
