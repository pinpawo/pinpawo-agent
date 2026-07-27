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

function eventMessage(
  event: Extract<AgentServerMessage, { type: 'event' }>['event'],
): AgentServerMessage {
  return {
    type: 'event',
    requestId: event.requestId,
    event,
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
