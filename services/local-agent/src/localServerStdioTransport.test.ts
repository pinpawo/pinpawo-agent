import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import type { LocalAgentServerMessage } from './localAgentProtocol';
import type { LocalServerPeerHandlers } from './localServerMessageDispatcher';
import type { LocalServerPeer } from './localServerPeer';
import {
  attachLocalServerStdioTransport,
  redirectConsoleToStdioDiagnostics,
} from './localServerStdioTransport';

function createHandlers(
  overrides: Partial<LocalServerPeerHandlers> = {},
): LocalServerPeerHandlers {
  return {
    onChatRequest: () => undefined,
    onStudioRequest: () => undefined,
    onHumanReviewResponse: () => undefined,
    onReviewCancel: () => undefined,
    onRunInterrupt: () => undefined,
    onNewSession: () => undefined,
    onRuntimeConfigUpdate: () => undefined,
    onClose: () => undefined,
    ...overrides,
  };
}

function collectText(stream: PassThrough) {
  let value = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    value += chunk;
  });
  return () => value;
}

function parseJsonLines(value: string) {
  return value.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as unknown);
}

async function assertEventually(assertion: () => void) {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < 500) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
    }
  }
  throw lastError;
}

class ControlledWritable extends Writable {
  readonly chunks: string[] = [];
  private readonly callbacks: Array<(error?: Error | null) => void> = [];

  constructor() {
    super({ highWaterMark: 1 });
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.chunks.push(chunk.toString());
    this.callbacks.push(callback);
  }

  releaseNext() {
    this.callbacks.shift()?.();
  }
}

test('stdio JSONL dispatch matches typed WebSocket behavior and closes one stable peer on EOF', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const diagnostics = new PassThrough();
  const readOutput = collectText(output);
  const readDiagnostics = collectText(diagnostics);
  const peers: LocalServerPeer[] = [];
  const transport = attachLocalServerStdioTransport(createHandlers({
    onChatRequest: (peer) => {
      peers.push(peer);
    },
    onClose: (peer) => {
      peers.push(peer);
    },
  }), {
    input,
    output,
    diagnostics,
  });

  input.write(`${JSON.stringify({ type: 'ping' })}\n`);
  input.write(`${JSON.stringify({
    type: 'chat_request',
    requestId: 'chat-1',
    message: 'hi',
  })}\n`);
  input.write(`${JSON.stringify({
    type: 'chat_request',
    requestId: 'chat-old',
    message: 'Approve',
    resume: { reviewId: 'review-1', selectedOptionId: 'approve' },
  })}\n`);
  input.write('{bad json\n');

  await assertEventually(() => {
    assert.equal(peers.length, 1);
    assert.deepEqual(parseJsonLines(readOutput()), [
      { type: 'pong' },
      {
        type: 'event',
        requestId: 'chat-old',
        event: {
          type: 'error',
          requestId: 'chat-old',
          message: '客户端消息协议不兼容或格式无效，请升级客户端后重试。',
        },
      },
    ]);
  });

  input.end();
  await transport.closed;

  assert.equal(transport.peer.isConnected(), false);
  assert.equal(peers.length, 2);
  assert.equal(peers[0], peers[1]);
  assert.match(readDiagnostics(), /type=chat_request requestId=chat-old/);
  assert.match(readDiagnostics(), /type=unknown requestId=unknown/);
});

test('stdio framing handles split chunks, CRLF, and a final line without newline', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const readOutput = collectText(output);
  const transport = attachLocalServerStdioTransport(createHandlers(), {
    input,
    output,
    diagnostics: new PassThrough(),
  });

  input.write('{"type":"pi');
  input.write('ng"}\r\n{"type":"ping"}');
  input.end();
  await transport.closed;

  assert.deepEqual(parseJsonLines(readOutput()), [
    { type: 'pong' },
    { type: 'pong' },
  ]);
});

test('stdio closes the peer when one input line exceeds the byte limit', async () => {
  const input = new PassThrough();
  const diagnostics = new PassThrough();
  const readDiagnostics = collectText(diagnostics);
  let closeCount = 0;
  const transport = attachLocalServerStdioTransport(createHandlers({
    onClose: () => {
      closeCount += 1;
    },
  }), {
    input,
    output: new PassThrough(),
    diagnostics,
    maxInputLineBytes: 4,
  });

  input.write('12345');
  await transport.closed;

  assert.equal(closeCount, 1);
  assert.equal(transport.peer.isConnected(), false);
  assert.match(readDiagnostics(), /stdio input line limit exceeded: line bytes exceed 4/);
});

test('stdio peer queues messages while stdout is backpressured and resumes on drain', async () => {
  const input = new PassThrough();
  const output = new ControlledWritable();
  const transport = attachLocalServerStdioTransport(createHandlers(), {
    input,
    output,
    diagnostics: new PassThrough(),
  });

  assert.equal(transport.peer.send({ type: 'pong' }), true);
  assert.equal(transport.peer.send({ type: 'interrupted', requestId: 'req-1' }), true);
  assert.equal(output.chunks.length, 1);

  output.releaseNext();
  await assertEventually(() => {
    assert.equal(output.chunks.length, 2);
  });
  assert.deepEqual(
    output.chunks.map((line) => JSON.parse(line) as LocalAgentServerMessage),
    [
      { type: 'pong' },
      { type: 'interrupted', requestId: 'req-1' },
    ],
  );

  output.releaseNext();
  transport.close();
  await transport.closed;
});

test('stdio EOF runs peer cleanup and waits for active dispatch handlers to settle', async () => {
  const input = new PassThrough();
  const sequence: string[] = [];
  let releaseRun: () => void = () => undefined;
  const runReleased = new Promise<void>((resolve) => {
    releaseRun = resolve;
  });
  const transport = attachLocalServerStdioTransport(createHandlers({
    onChatRequest: async () => {
      sequence.push('run-started');
      await runReleased;
      sequence.push('run-settled');
    },
    onClose: () => {
      sequence.push('peer-closed');
      releaseRun();
    },
  }), {
    input,
    output: new PassThrough(),
    diagnostics: new PassThrough(),
  });

  input.end(`${JSON.stringify({
    type: 'chat_request',
    requestId: 'chat-1',
    message: 'hi',
  })}\n`);
  await transport.closed;

  assert.deepEqual(sequence, [
    'run-started',
    'peer-closed',
    'run-settled',
  ]);
});

test('stdio peer makes output failures observable and rejects later sends', async () => {
  const diagnostics = new PassThrough();
  const readDiagnostics = collectText(diagnostics);
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error('write exploded'));
    },
  });
  const transport = attachLocalServerStdioTransport(createHandlers(), {
    input: new PassThrough(),
    output,
    diagnostics,
  });

  assert.equal(transport.peer.send({ type: 'pong' }), true);
  await transport.closed;

  assert.equal(transport.peer.isConnected(), false);
  assert.equal(transport.peer.send({ type: 'pong' }), false);
  assert.match(readDiagnostics(), /stdio output failed: write exploded/);
});

test('stdio peer closes when the bounded backpressure queue overflows', async () => {
  const output = new ControlledWritable();
  const diagnostics = new PassThrough();
  const readDiagnostics = collectText(diagnostics);
  const transport = attachLocalServerStdioTransport(createHandlers(), {
    input: new PassThrough(),
    output,
    diagnostics,
    maxPendingBytes: 1,
  });

  assert.equal(transport.peer.send({ type: 'pong' }), true);
  assert.equal(transport.peer.send({ type: 'interrupted', requestId: 'req-1' }), false);
  await transport.closed;

  output.releaseNext();
  assert.equal(transport.peer.isConnected(), false);
  assert.match(readDiagnostics(), /stdio output backpressure limit exceeded/);
});

test('stdio console redirection keeps diagnostics off protocol stdout', () => {
  const diagnostics = new PassThrough();
  const readDiagnostics = collectText(diagnostics);
  const restore = redirectConsoleToStdioDiagnostics(diagnostics);
  try {
    console.log('diagnostic only');
  } finally {
    restore();
  }

  assert.match(readDiagnostics(), /diagnostic only/);
});
