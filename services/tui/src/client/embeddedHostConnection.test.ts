import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import type { AgentHostConnectionHandlers } from './agentHostConnection';
import {
  createEmbeddedHostConnectionFactory,
  EmbeddedHostConnection,
  type EmbeddedHostChild,
  type EmbeddedHostSpawn,
} from './embeddedHostConnection';

class FakeHostChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: string[] = [];
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  kill(signal: NodeJS.Signals = 'SIGTERM') {
    if (this.exitCode !== null || this.signalCode !== null) return false;
    this.signals.push(signal);
    this.signalCode = signal;
    this.emit('exit', signal);
    return true;
  }

  emitSpawn() {
    this.emit('spawn');
  }

  emitExit(code = 0) {
    this.exitCode = code;
    this.emit('exit', code, null);
  }

  writeStdout(text: string) {
    this.stdout.write(text);
  }

  writeStderr(text: string) {
    this.stderr.write(text);
  }

  asChild() {
    return this as unknown as EmbeddedHostChild;
  }
}

function createHandlers(events: string[]): AgentHostConnectionHandlers {
  return {
    onOpen: () => events.push('open'),
    onMessage: (message) => events.push(`message:${message.type}`),
    onClose: () => events.push('close'),
    onError: (error: Error) => events.push(`error:${error.message}`),
  };
}

function recordingSpawn(child: FakeHostChild, calls: SpawnCall[]): EmbeddedHostSpawn {
  return (command, args, options) => {
    calls.push({
      command,
      args: [...args],
      cwd: options.cwd,
      stdio: options.stdio,
    });
    return child.asChild();
  };
}

type SpawnCall = {
  command: string;
  args: string[];
  cwd: string;
  stdio: readonly string[];
};

test('embedded host spawns one piped child and frames JSONL stdout', async () => {
  const child = new FakeHostChild();
  const calls: SpawnCall[] = [];
  const events: string[] = [];
  const connection = new EmbeddedHostConnection(createHandlers(events), {
    command: '/usr/local/bin/node',
    args: ['run', '--stdio'],
    cwd: '/workspace/project',
    spawnProcess: recordingSpawn(child, calls),
  });

  connection.connect();
  // A second connect while the child is alive must not start a second Host.
  connection.connect();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    command: '/usr/local/bin/node',
    args: ['run', '--stdio'],
    cwd: '/workspace/project',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  assert.equal(connection.isConnected(), false);
  assert.deepEqual(events, []);

  child.emitSpawn();
  assert.equal(connection.isConnected(), true);
  assert.deepEqual(events, ['open']);

  // One message split across two reads, then two whole messages in one read.
  child.writeStdout('{"type":"pong"}\n{"type":"interrup');
  child.writeStdout('ting","requestId":"second"}\n{"type":"pong"}\n');
  await flushTasks();

  assert.deepEqual(events, [
    'open',
    'message:pong',
    'message:interrupting',
    'message:pong',
  ]);
});

test('embedded host writes one JSONL command per send and keeps backpressure connected', () => {
  const child = new FakeHostChild();
  const events: string[] = [];
  const connection = new EmbeddedHostConnection(createHandlers(events), {
    command: 'pinpawo',
    cwd: '/workspace/project',
    spawnProcess: recordingSpawn(child, []),
  });
  const writes: string[] = [];
  // A full pipe buffer reports `false` from write(); that is backpressure, not
  // a closed Host, and must not be reported to the session layer as failure.
  child.stdin.write = ((chunk: string) => {
    writes.push(chunk);
    return false;
  }) as typeof child.stdin.write;

  connection.connect();
  child.emitSpawn();

  assert.equal(connection.send({ type: 'ping' }), true);
  assert.deepEqual(writes, ['{"type":"ping"}\n']);
  assert.deepEqual(events, ['open']);

  connection.disconnect();
});

test('embedded host reports an invalid protocol line as a closed connection', async () => {
  const child = new FakeHostChild();
  const events: string[] = [];
  const connection = new EmbeddedHostConnection(createHandlers(events), {
    command: 'pinpawo',
    cwd: '/workspace/project',
    spawnProcess: recordingSpawn(child, []),
  });

  connection.connect();
  child.emitSpawn();
  child.writeStdout('{invalid\n');
  await flushTasks();

  assert.deepEqual(events, [
    'open',
    'error:local-agent sent an invalid protocol message',
    'close',
  ]);
  assert.equal(connection.isConnected(), false);
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.equal(connection.send({ type: 'ping' }), false);
});

test('embedded host reports child exit as a disconnect', async () => {
  const child = new FakeHostChild();
  const events: string[] = [];
  const connection = new EmbeddedHostConnection(createHandlers(events), {
    command: 'pinpawo',
    cwd: '/workspace/project',
    spawnProcess: recordingSpawn(child, []),
  });

  connection.connect();
  child.emitSpawn();
  child.emitExit(7);

  assert.deepEqual(events, ['open', 'close']);
  assert.equal(connection.isConnected(), false);
  // Idempotent teardown: an exited child is not signalled again.
  connection.disconnect();
  assert.deepEqual(child.signals, []);
});

test('embedded host collects stderr without writing it to the terminal', async () => {
  const child = new FakeHostChild();
  const events: string[] = [];
  const diagnostics: string[] = [];
  const connection = new EmbeddedHostConnection(createHandlers(events), {
    command: 'pinpawo',
    cwd: '/workspace/project',
    spawnProcess: recordingSpawn(child, []),
    maxDiagnosticLines: 2,
    onDiagnostics: (line) => diagnostics.push(line),
  });

  connection.connect();
  child.emitSpawn();
  child.writeStderr('[local-server] stdio JSONL transport ready\n');
  child.writeStderr('[local-agent] first\n[local-agent] second\n\n');
  await flushTasks();

  assert.deepEqual(diagnostics, [
    '[local-server] stdio JSONL transport ready',
    '[local-agent] first',
    '[local-agent] second',
  ]);
  assert.deepEqual(connection.readDiagnostics(), [
    '[local-agent] first',
    '[local-agent] second',
  ]);
  // The terminal UI only ever sees connection lifecycle events.
  assert.deepEqual(events, ['open']);
});

test('embedded host explains a Host that cannot be started', () => {
  const events: string[] = [];
  const connection = new EmbeddedHostConnection(createHandlers(events), {
    command: 'missing-pinpawo',
    cwd: '/workspace/project',
    spawnProcess: () => {
      throw Object.assign(new Error('spawn missing-pinpawo ENOENT'), {
        code: 'ENOENT',
      });
    },
  });

  connection.connect();

  assert.deepEqual(events, [
    'error:could not start the local-agent Host (missing-pinpawo):'
      + ' spawn missing-pinpawo ENOENT.'
      + ' Start `pinpawo tui` so the launcher can pass the Host runtime,'
      + ' or set PINPAWO_EMBED_HOST_COMMAND and PINPAWO_EMBED_HOST_ARGS.',
    'close',
  ]);
  assert.equal(connection.isConnected(), false);
});

test('embedded host treats a pre-spawn child error as a startup failure', () => {
  const child = new FakeHostChild();
  const events: string[] = [];
  const connection = new EmbeddedHostConnection(createHandlers(events), {
    command: 'missing-pinpawo',
    cwd: '/workspace/project',
    spawnProcess: recordingSpawn(child, []),
  });

  connection.connect();
  child.emit('error', new Error('spawn missing-pinpawo ENOENT'));

  assert.deepEqual(events.slice(-2), [
    'error:could not start the local-agent Host (missing-pinpawo):'
      + ' spawn missing-pinpawo ENOENT.'
      + ' Start `pinpawo tui` so the launcher can pass the Host runtime,'
      + ' or set PINPAWO_EMBED_HOST_COMMAND and PINPAWO_EMBED_HOST_ARGS.',
    'close',
  ]);
});

test('embedded host shuts the Host down on disconnect and stays idempotent', () => {
  const child = new FakeHostChild();
  const events: string[] = [];
  const connection = new EmbeddedHostConnection(createHandlers(events), {
    command: 'pinpawo',
    cwd: '/workspace/project',
    spawnProcess: recordingSpawn(child, []),
  });

  connection.connect();
  child.emitSpawn();
  connection.disconnect();

  assert.equal(child.stdin.writableEnded, true);
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.equal(connection.isConnected(), false);

  connection.disconnect();
  assert.deepEqual(child.signals, ['SIGTERM']);
});

test('createEmbeddedHostConnectionFactory reuses one Host command per connection', () => {
  const calls: SpawnCall[] = [];
  const factory = createEmbeddedHostConnectionFactory({
    command: 'pinpawo',
    args: ['run', '--stdio'],
    cwd: '/workspace/project',
    spawnProcess: recordingSpawn(new FakeHostChild(), calls),
  });
  const first = factory(createHandlers([]));
  const second = factory(createHandlers([]));

  first.connect();
  second.connect();

  assert.deepEqual(calls, [
    {
      command: 'pinpawo',
      args: ['run', '--stdio'],
      cwd: '/workspace/project',
      stdio: ['pipe', 'pipe', 'pipe'],
    },
    {
      command: 'pinpawo',
      args: ['run', '--stdio'],
      cwd: '/workspace/project',
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  ]);
  assert.notEqual(first, second);
});

async function flushTasks() {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}
