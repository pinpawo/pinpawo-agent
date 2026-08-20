import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentSessionSnapshot } from '@pinpawo/agent-session';
import { FakeConnection } from './sessionControllerTestSupport';
import {
  SessionTransportCoordinator,
} from './sessionTransportCoordinator';

test('session transport owns snapshot correlation and forwards application messages', () => {
  const requestIds = ['startup', 'completion'];
  let connection!: FakeConnection;
  const connections: Array<readonly [string, string | undefined]> = [];
  const snapshots: string[] = [];
  const messages: string[] = [];
  const transport = new SessionTransportCoordinator({
    connectionFactory: (handlers) => {
      connection = new FakeConnection(handlers);
      return connection;
    },
    requestIdFactory: () => requestIds.shift() ?? 'unexpected',
    reconnectDelaysMs: [10],
    snapshotTimeoutMs: 1_000,
    setTimer: setTimeout,
    clearTimer: clearTimeout,
    onConnection: (state, detail) => {
      connections.push([state, detail]);
    },
    onSnapshot: (_snapshot, reason) => {
      snapshots.push(reason);
    },
    onMessage: (message) => {
      messages.push(message.type);
    },
    onDisconnected: () => undefined,
  });

  transport.start();
  connection.open();
  assert.deepEqual(connection.sent.at(-1), {
    type: 'session.snapshot.get',
    requestId: 'startup',
  });
  connection.receive(snapshot('startup'));
  assert.deepEqual(snapshots, ['startup']);

  connection.receive({
    type: 'event',
    requestId: 'chat',
    event: {
      type: 'message.delta',
      requestId: 'chat',
      messageId: 'chat:assistant',
      role: 'assistant',
      text: 'hello',
    },
  });
  assert.deepEqual(messages, ['event']);

  transport.requestCompletionSnapshot();
  connection.receive(snapshot('completion'));
  assert.deepEqual(snapshots, ['startup', 'completion']);
  assert.deepEqual(connections.slice(0, 2), [
    ['connecting', 'connecting to local-agent'],
    ['connecting', 'synchronizing session'],
  ]);
  transport.stop();
});

test('session transport consumes snapshot errors but forwards command errors', () => {
  let connection!: FakeConnection;
  const connections: Array<readonly [string, string | undefined]> = [];
  const messages: string[] = [];
  const transport = new SessionTransportCoordinator({
    connectionFactory: (handlers) => {
      connection = new FakeConnection(handlers);
      return connection;
    },
    requestIdFactory: () => 'startup',
    reconnectDelaysMs: [10],
    snapshotTimeoutMs: 1_000,
    setTimer: setTimeout,
    clearTimer: clearTimeout,
    onConnection: (state, detail) => {
      connections.push([state, detail]);
    },
    onSnapshot: () => undefined,
    onMessage: (message) => {
      messages.push(message.type);
    },
    onDisconnected: () => undefined,
  });

  transport.start();
  connection.open();
  connection.receive({
    type: 'session.error',
    requestId: 'startup',
    operation: 'snapshot',
    message: 'snapshot failed',
  });
  assert.deepEqual(connections.at(-1), ['error', 'snapshot failed']);

  connection.receive({
    type: 'session.error',
    requestId: 'list',
    operation: 'list',
    message: 'list failed',
  });
  assert.deepEqual(messages, ['session.error']);
  transport.stop();
});

function snapshot(requestId: string) {
  return {
    type: 'session.snapshot.result' as const,
    requestId,
    snapshot: createAgentSessionSnapshot({
      sessionId: 'chat:one',
      kind: 'chat',
      timeline: [],
      activeRun: null,
    }),
  };
}
