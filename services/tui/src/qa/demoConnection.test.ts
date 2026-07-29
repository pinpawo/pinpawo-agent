import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  AgentServerMessage,
  AgentSessionSnapshot,
} from '@pinpawo/agent-session';
import {
  createDemoConnectionFactory,
} from './demoConnection';
import { buildDemoQaEventSequence } from './demoQaScenario';

test('QA event sequence exposes each live timeline phase before completion', () => {
  const steps = buildDemoQaEventSequence('qa-request');
  assert.deepEqual(
    steps.map((step) => [
      step.delayMs,
      step.event.type,
      step.event.type === 'operation' ? step.event.phase : null,
    ]),
    [
      [700, 'operation', 'started'],
      [1_400, 'operation', 'updated'],
      [2_100, 'operation', 'completed'],
      [2_800, 'subagent.message.completed', null],
      [3_500, 'message.delta', null],
      [4_200, 'message.delta', null],
      [5_600, 'message.completed', null],
    ],
  );
});

test('QA demo transport retains the completed canonical timeline for refresh', () => {
  const scheduler = createScheduler();
  const received: AgentServerMessage[] = [];
  const connection = createDemoConnectionFactory({
    qa: true,
    schedule: scheduler.schedule,
    clearScheduled: scheduler.clear,
  })({
    onOpen: () => {},
    onMessage: (message) => received.push(message),
    onClose: () => {},
    onError: () => {},
  });
  connection.connect();
  assert.equal(connection.send({
    type: 'chat_request',
    requestId: 'qa-request',
    message: 'Inspect 中文 🙂 input.',
  }), true);
  assert.equal(scheduler.pending.length, 7);

  scheduler.runAll();
  assert.deepEqual(
    received
      .filter((message) => message.type === 'event')
      .map((message) => (
        message.event.type === 'operation'
          ? `${message.event.type}:${message.event.phase}`
          : message.event.type
      )),
    [
      'operation:started',
      'operation:updated',
      'operation:completed',
      'subagent.message.completed',
      'message.delta',
      'message.delta',
      'message.completed',
    ],
  );

  connection.send({
    type: 'session.snapshot.get',
    requestId: 'refresh',
  });
  const snapshot = readSnapshot(received, 'refresh');
  assert.equal(snapshot.session.activeRun, null);
  assert.deepEqual(
    snapshot.session.timeline.slice(-4).map((entry) => (
      entry.type === 'operation'
        ? `operation:${entry.phase}`
        : `${entry.role}:${entry.status}`
    )),
    [
      'user:completed',
      'operation:completed',
      'subagent:completed',
      'assistant:completed',
    ],
  );
  const completed = snapshot.session.timeline.at(-1);
  assert.equal(
    completed?.type === 'message' ? completed.text : null,
    [
      '## QA response',
      '',
      'Streaming **Markdown** stays editable while history is browsed.',
      '',
      '完成 🙂',
    ].join('\n'),
  );
  assert.equal(snapshot.session.tokenUsage?.inputTokens, 20_000);
  connection.disconnect();
});

test('QA demo interrupt cancels future stream events and settles the run', () => {
  const scheduler = createScheduler();
  const received: AgentServerMessage[] = [];
  const connection = createDemoConnectionFactory({
    qa: true,
    schedule: scheduler.schedule,
    clearScheduled: scheduler.clear,
  })({
    onOpen: () => {},
    onMessage: (message) => received.push(message),
    onClose: () => {},
    onError: () => {},
  });
  connection.connect();
  connection.send({
    type: 'chat_request',
    requestId: 'qa-interrupt',
    message: 'Stop this response.',
  });
  assert.equal(scheduler.pending.length, 7);
  connection.send({
    type: 'run.interrupt',
    requestId: 'qa-interrupt',
  });
  assert.equal(
    received.at(-1)?.type,
    'interrupting',
  );
  assert.equal(scheduler.pending.length, 1);

  scheduler.runAll();
  assert.equal(
    received.some((message) => message.type === 'event'),
    false,
  );
  assert.equal(received.at(-1)?.type, 'interrupted');

  connection.send({
    type: 'session.snapshot.get',
    requestId: 'interrupt-refresh',
  });
  const snapshot = readSnapshot(received, 'interrupt-refresh');
  assert.equal(snapshot.session.activeRun, null);
  const interrupted = snapshot.session.timeline.at(-1);
  assert.equal(
    interrupted?.type === 'message' ? interrupted.text : null,
    'QA response interrupted.',
  );
  connection.disconnect();
});

test('review demo reports resumable delegation after cancellation', () => {
  const received: AgentServerMessage[] = [];
  const connection = createDemoConnectionFactory({
    review: true,
  })({
    onOpen: () => {},
    onMessage: (message) => received.push(message),
    onClose: () => {},
    onError: () => {},
  });
  connection.connect();

  assert.equal(connection.send({
    type: 'review.cancel',
    requestId: 'smoke-run',
    actionId: 'smoke-review-action',
  }), true);
  assert.equal(connection.send({
    type: 'session.snapshot.get',
    requestId: 'after-cancel',
  }), true);

  assert.equal(
    readSnapshot(received, 'after-cancel')
      .session.hasResumableDelegation,
    true,
  );
  connection.disconnect();
});

test('QA demo disconnect settles an orphaned run before reconnect snapshot', () => {
  const scheduler = createScheduler();
  const received: AgentServerMessage[] = [];
  const connection = createDemoConnectionFactory({
    qa: true,
    schedule: scheduler.schedule,
    clearScheduled: scheduler.clear,
  })({
    onOpen: () => {},
    onMessage: (message) => received.push(message),
    onClose: () => {},
    onError: () => {},
  });
  connection.connect();
  connection.send({
    type: 'chat_request',
    requestId: 'qa-disconnect',
    message: 'Disconnect this response.',
  });
  assert.equal(scheduler.pending.length, 7);

  connection.disconnect();
  assert.equal(scheduler.pending.length, 0);
  scheduler.runAll();
  assert.equal(
    received.some((message) => message.type === 'event'),
    false,
  );

  connection.connect();
  connection.send({
    type: 'session.snapshot.get',
    requestId: 'reconnect',
  });
  const snapshot = readSnapshot(received, 'reconnect');
  assert.equal(snapshot.session.activeRun, null);
  const stopped = snapshot.session.timeline.at(-1);
  assert.equal(
    stopped?.type === 'message' ? stopped.text : null,
    'QA response stopped after the demo transport disconnected.',
  );
  connection.disconnect();
});

function createScheduler() {
  type Scheduled = {
    callback: () => void;
    delayMs: number;
    cancelled: boolean;
  };
  const scheduled: Scheduled[] = [];
  return {
    schedule(callback: () => void, delayMs: number) {
      const item = { callback, delayMs, cancelled: false };
      scheduled.push(item);
      return item;
    },
    clear(handle: unknown) {
      (handle as Scheduled).cancelled = true;
    },
    get pending() {
      return scheduled.filter((item) => !item.cancelled);
    },
    runAll() {
      for (const item of [...scheduled].sort(
        (left, right) => left.delayMs - right.delayMs,
      )) {
        if (!item.cancelled) item.callback();
      }
    },
  };
}

function readSnapshot(
  messages: readonly AgentServerMessage[],
  requestId: string,
): AgentSessionSnapshot {
  const message = messages.find((candidate) => (
    candidate.type === 'session.snapshot.result'
    && candidate.requestId === requestId
  ));
  assert.ok(message?.type === 'session.snapshot.result');
  return message.snapshot;
}
