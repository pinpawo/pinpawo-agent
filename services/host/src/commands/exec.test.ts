import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createAgentSessionSnapshot,
  type AgentClientMessage,
  type AgentRuntimeEvent,
  type AgentServerMessage,
} from '@pinpawo/agent-session';
import { runExec, runExecSession, type ExecHostProcess } from './exec';

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
        { id: 'c1', name: 'plan_request', args: {} },
        { id: 'c2', name: 'delegate_capability', args: {} },
      ],
    } as unknown as AgentRuntimeEvent));
    // The delegation's own operation, then the subagent's tools: each call id
    // counts once however many phases it reports.
    for (const [callId, toolName, phase] of [
      ['c2', 'delegate_capability', 'started'],
      ['s1', 'run_shell', 'started'],
      ['s1', 'run_shell', 'completed'],
      ['s2', 'run_shell', 'started'],
      ['s3', 'write_file', 'started'],
    ] as const) {
      fake.emit(runEvent({
        type: 'operation',
        requestId,
        phase,
        operation: {
          id: callId,
          kind: 'tool',
          source: { provider: 'toolkit', name: 'shell', toolName, callId },
        },
      }));
    }
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
  assert.equal(result.mainToolCalls, 2);
  assert.equal(result.executedToolCalls, 3);
  assert.deepEqual(result.executedToolCallsByName, { run_shell: 2, write_file: 1 });
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

test('an unusable output path fails before any Host starts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pinpawo-exec-'));
  const notADirectory = join(dir, 'file');
  writeFileSync(notADirectory, '');
  let spawned = 0;
  const spawnHost = () => {
    spawned += 1;
    return createFakeHost(() => undefined);
  };

  await assert.rejects(runExec({
    instruction: 'x',
    trajectoryPath: join(notADirectory, 'trajectory.jsonl'),
  }, spawnHost));
  await assert.rejects(runExec({
    instruction: 'x',
    outputPath: join(notADirectory, 'result.json'),
  }, spawnHost));

  assert.equal(spawned, 0);
});

test('exec shuts the Host down and keeps the trajectory once the run ends', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pinpawo-exec-'));
  let stdinClosed = false;
  const host = createFakeHost((message, fake) => {
    if (answerSessionNew(message, fake)) return;
    if (message.type !== 'chat_request') return;
    fake.emit(runEvent({
      type: 'message.completed',
      requestId: message.requestId,
      messageId: 'm1',
      role: 'assistant',
      text: 'ok',
    }));
  });
  // The fake Host exits when its stdin closes, like the real one.
  host.stdin.on('finish', () => {
    stdinClosed = true;
    host.exit();
  });
  const previousExitCode = process.exitCode;
  const previousWrite = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  let result;
  try {
    result = await runExec({
      instruction: 'x',
      trajectoryPath: join(dir, 'logs', 'trajectory.jsonl'),
      outputPath: join(dir, 'logs', 'result.json'),
    }, () => host);
  } finally {
    process.stdout.write = previousWrite;
    process.exitCode = previousExitCode;
  }

  assert.equal(result.status, 'completed');
  assert.ok(stdinClosed);
  assert.ok(existsSync(join(dir, 'logs', 'result.json')));
  const lines = readFileSync(join(dir, 'logs', 'trajectory.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
});
