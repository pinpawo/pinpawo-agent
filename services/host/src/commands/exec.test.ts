import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  createAgentSessionSnapshot,
  type AgentClientMessage,
  type AgentRuntimeEvent,
  type AgentServerMessage,
} from '@pinpawo/agent-session';
import { runExecSession, type ExecHostProcess } from './exec';

type FakeHost = ExecHostProcess & {
  received: AgentClientMessage[];
  emit: (message: AgentServerMessage) => void;
  exit: () => void;
};

/** A Host stand-in that answers each client message through `respond`. */
function createFakeHost(
  respond: (message: AgentClientMessage, host: FakeHost) => void,
): FakeHost {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let exit: () => void = () => undefined;
  const exited = new Promise<void>((resolve) => { exit = resolve; });
  const host: FakeHost = {
    stdin,
    stdout,
    exited,
    kill: () => exit(),
    received: [],
    emit: (message) => { stdout.write(`${JSON.stringify(message)}\n`); },
    exit: () => exit(),
  };
  let buffer = '';
  stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const message = JSON.parse(buffer.slice(0, newline)) as AgentClientMessage;
      buffer = buffer.slice(newline + 1);
      host.received.push(message);
      respond(message, host);
      newline = buffer.indexOf('\n');
    }
  });
  return host;
}

function runEvent(event: AgentRuntimeEvent): AgentServerMessage {
  return { type: 'event', requestId: event.requestId, event };
}

function answerSessionNew(message: AgentClientMessage, host: FakeHost) {
  if (message.type !== 'session.new') return false;
  host.emit({
    type: 'session.new.result',
    requestId: message.requestId,
    session: {
      id: 'chat:exec',
      kind: 'chat',
      title: 'New session',
      messageCount: 0,
      createdAt: '2026-10-10T00:00:00.000Z',
      updatedAt: '2026-10-10T00:00:00.000Z',
      active: true,
    },
    snapshot: createAgentSessionSnapshot({
      sessionId: 'chat:exec',
      kind: 'chat',
      timeline: [],
      activeRun: null,
      pendingInterrupt: null,
    }),
  });
  return true;
}

test('exec opens a fresh session, sends the instruction, and returns the final reply', async () => {
  const host = createFakeHost((message, fake) => {
    if (answerSessionNew(message, fake)) return;
    if (message.type !== 'chat_request') return;
    const requestId = message.requestId;
    fake.emit(runEvent({ type: 'run.started', requestId, initiator: 'client' }));
    fake.emit(runEvent({
      type: 'message.tool_calls',
      requestId,
      messageId: 'm1',
      text: '',
      toolCalls: [
        { id: 'c1', name: 'shell', args: {} },
        { id: 'c2', name: 'read_file', args: {} },
      ],
    } as unknown as AgentRuntimeEvent));
    // Another request's events must not end this run.
    fake.emit(runEvent({ type: 'error', requestId: 'other', message: 'unrelated' }));
    fake.emit(runEvent({
      type: 'message.completed',
      requestId,
      messageId: 'm2',
      role: 'assistant',
      text: 'done',
    }));
  });

  const seen: string[] = [];
  const result = await runExecSession(host, {
    instruction: 'make it pass',
    onMessage: (message) => seen.push(message.type),
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.reply, 'done');
  assert.equal(result.toolCalls, 2);
  assert.deepEqual(host.received.map((message) => message.type), ['session.new', 'chat_request']);
  const chat = host.received[1];
  assert.equal(chat.type === 'chat_request' ? chat.message : null, 'make it pass');
  assert.ok(seen.includes('session.new.result'));
});

test('a run that stops on an interrupt reports waiting with the interrupt kind', async () => {
  const host = createFakeHost((message, fake) => {
    if (answerSessionNew(message, fake)) return;
    if (message.type !== 'chat_request') return;
    fake.emit(runEvent({
      type: 'interrupt.requested',
      requestId: message.requestId,
      pendingInterrupt: { interruptId: 'i1', payload: { kind: 'human_review', interactions: [] } },
    }));
  });

  const result = await runExecSession(host, { instruction: 'rm -rf build' });

  assert.equal(result.status, 'waiting');
  assert.equal(result.pendingInterruptKind, 'human_review');
});

test('a session that cannot be opened fails without sending the instruction', async () => {
  const host = createFakeHost((message, fake) => {
    if (message.type !== 'session.new') return;
    fake.emit({
      type: 'session.error',
      requestId: message.requestId,
      operation: 'new',
      message: 'no model profile',
    });
  });

  const result = await runExecSession(host, { instruction: 'hello' });

  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'no model profile');
  assert.deepEqual(host.received.map((message) => message.type), ['session.new']);
});

test('a timeout interrupts the run and reports timeout once it settles', async () => {
  const host = createFakeHost((message, fake) => {
    if (answerSessionNew(message, fake)) return;
    if (message.type === 'run.interrupt') {
      fake.emit(runEvent({ type: 'run.interrupted', requestId: message.requestId }));
    }
  });

  const result = await runExecSession(host, { instruction: 'loop forever', timeoutMs: 20 });

  assert.equal(result.status, 'timeout');
  assert.deepEqual(
    host.received.map((message) => message.type),
    ['session.new', 'chat_request', 'run.interrupt'],
  );
});

test('a Host that exits mid-run fails the run', async () => {
  const host = createFakeHost((message, fake) => {
    if (answerSessionNew(message, fake)) return;
    if (message.type === 'chat_request') fake.exit();
  });

  const result = await runExecSession(host, { instruction: 'crash' });

  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /exited/);
});
