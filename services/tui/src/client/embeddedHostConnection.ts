/**
 * Embedded stdio transport: the terminal UI starts the local agent Host as its
 * own child process and speaks the shared JSONL protocol over the child's
 * stdin/stdout.
 *
 * This is the second implementation of `AgentHostConnection`, so the session
 * layer is unchanged. Two invariants make it work:
 *
 * - The Host's stdio is piped, never inherited, because the terminal UI owns
 *   the terminal for its own rendering. This also keeps Host diagnostics off
 *   the OpenTUI screen; they are collected for the log sink instead.
 * - Closing stdin is the Host's shutdown signal (the stdio transport ends the
 *   peer on EOF), so this transport has no reconnect: a connect after a
 *   disconnect starts a new Host process.
 */
import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import {
  parseAgentServerMessage,
  type AgentClientMessage,
} from '@pinpawo/agent-session';
import type {
  AgentHostConnection,
  AgentHostConnectionFactory,
  AgentHostConnectionHandlers,
} from './agentHostConnection';

const DEFAULT_MAX_DIAGNOSTIC_LINES = 50;

export type EmbeddedHostChild = ChildProcessWithoutNullStreams;

export type EmbeddedHostSpawn = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: ['pipe', 'pipe', 'pipe'];
  },
) => EmbeddedHostChild;

export type EmbeddedHostConnectionOptions = {
  /** Executable that starts the Host, e.g. `process.execPath` or `pinpawo`. */
  command: string;
  /** Arguments after the command, e.g. `['run', '--stdio']`. */
  args?: readonly string[];
  /** Working directory for the Host; the Host derives its workdir from it. */
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests, matching the other TUI child-process helpers. */
  spawnProcess?: EmbeddedHostSpawn;
  /** Host stderr lines, for a log sink. Never written to the terminal. */
  onDiagnostics?: (line: string) => void;
  /** Bounded in-memory Host stderr history; defaults to 50 lines. */
  maxDiagnosticLines?: number;
};

export class EmbeddedHostConnection implements AgentHostConnection {
  private readonly spawnProcess: EmbeddedHostSpawn;
  private readonly diagnosticLines: string[] = [];
  private child: EmbeddedHostChild | null = null;
  private detachChildListeners: (() => void) | null = null;
  private opened = false;
  private stdoutBuffer = '';
  private stderrBuffer = '';

  constructor(
    private readonly handlers: AgentHostConnectionHandlers,
    private readonly options: EmbeddedHostConnectionOptions,
  ) {
    this.spawnProcess = options.spawnProcess ?? spawn;
  }

  connect() {
    // One Host per connection: a second connect() while the child is alive must
    // not leave two Hosts racing over the same session state.
    if (this.child) return;

    let child: EmbeddedHostChild;
    try {
      child = this.spawnProcess(this.options.command, this.options.args ?? [], {
        cwd: this.options.cwd,
        env: this.options.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.handlers.onError(describeStartupError(this.options, error));
      this.handlers.onClose();
      return;
    }

    this.child = child;
    this.opened = false;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';

    const onSpawn = () => {
      if (this.child !== child) return;
      this.opened = true;
      this.handlers.onOpen();
    };
    const onStdoutData = (chunk: string | Buffer) => {
      if (this.child !== child) return;
      this.consumeStdout(child, chunk);
    };
    const onStderrData = (chunk: string | Buffer) => {
      if (this.child !== child) return;
      this.consumeStderr(chunk);
    };
    const onError = (error: Error) => {
      if (this.child !== child) return;
      this.failChild(
        child,
        this.opened ? error : describeStartupError(this.options, error),
      );
    };
    const onExit = () => {
      if (this.child !== child) return;
      this.detachChild();
      this.handlers.onClose();
    };

    // `setEncoding` keeps a multi-byte character split across two pipe reads
    // intact; the line buffer below then only has to handle framing.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.once('spawn', onSpawn);
    child.stdout.on('data', onStdoutData);
    child.stderr.on('data', onStderrData);
    child.once('error', onError);
    child.once('exit', onExit);
    this.detachChildListeners = () => {
      child.off('spawn', onSpawn);
      child.stdout.off('data', onStdoutData);
      child.stderr.off('data', onStderrData);
      child.off('exit', onExit);
      // A detached child that fails afterwards (EPIPE, a late ENOENT) must not
      // surface as an unhandled 'error' event inside the terminal UI.
      child.off('error', onError);
      child.on('error', () => undefined);
    };
  }

  disconnect() {
    const child = this.child;
    if (!child) return;
    this.detachChild();
    if (isChildExited(child)) return;
    // Ending stdin asks the Host to abort in-flight work and exit on its own
    // terms. SIGTERM follows as the fallback: unlike WebSocket, this transport
    // cannot reconnect, so a Host that ignores EOF would block the next start.
    try {
      child.stdin.end();
    } catch {
      // The SIGTERM below still has to run when stdin is already gone.
    }
    killChild(child);
  }

  send(message: AgentClientMessage) {
    const child = this.child;
    if (!child || !this.isConnected()) return false;
    let line: string;
    try {
      line = `${JSON.stringify(message)}\n`;
    } catch (error) {
      this.failChild(child, toError(error));
      return false;
    }
    try {
      // A full pipe buffer is backpressure, not a closed connection: the line
      // stays queued in memory. Reporting `false` here would make the session
      // layer treat a slow Host as a disconnected one and restart it.
      child.stdin.write(line);
      return true;
    } catch (error) {
      this.failChild(child, toError(error));
      return false;
    }
  }

  isConnected() {
    return this.opened
      && this.child !== null
      && !isChildExited(this.child)
      && !this.child.stdin.destroyed;
  }

  /** Bounded Host stderr history, newest last. */
  readDiagnostics(): readonly string[] {
    return [...this.diagnosticLines];
  }

  private consumeStdout(child: EmbeddedHostChild, chunk: string | Buffer) {
    this.stdoutBuffer += readChunk(chunk);
    let newline = this.stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      this.dispatchLine(child, line);
      // A malformed line closes the connection; stop framing its leftovers.
      if (this.child !== child) return;
      newline = this.stdoutBuffer.indexOf('\n');
    }
  }

  private dispatchLine(child: EmbeddedHostChild, line: string) {
    const text = stripCarriageReturn(line);
    if (text === '') return;
    const message = parseAgentServerMessage(text);
    if (!message) {
      this.failChild(
        child,
        new Error('local-agent sent an invalid protocol message'),
      );
      return;
    }
    this.handlers.onMessage(message);
  }

  private consumeStderr(chunk: string | Buffer) {
    this.stderrBuffer += readChunk(chunk);
    let newline = this.stderrBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.stderrBuffer.slice(0, newline);
      this.stderrBuffer = this.stderrBuffer.slice(newline + 1);
      this.recordDiagnostic(line);
      newline = this.stderrBuffer.indexOf('\n');
    }
  }

  private recordDiagnostic(line: string) {
    const text = stripCarriageReturn(line);
    if (text.trim() === '') return;
    this.diagnosticLines.push(text);
    const limit = this.options.maxDiagnosticLines ?? DEFAULT_MAX_DIAGNOSTIC_LINES;
    while (this.diagnosticLines.length > limit) {
      this.diagnosticLines.shift();
    }
    this.options.onDiagnostics?.(text);
  }

  private failChild(child: EmbeddedHostChild, error: Error) {
    if (this.child !== child) return;
    this.handlers.onError(error);
    this.detachChild();
    killChild(child);
    this.handlers.onClose();
  }

  private detachChild() {
    this.detachChildListeners?.();
    this.detachChildListeners = null;
    this.child = null;
    this.opened = false;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
  }
}

export function createEmbeddedHostConnectionFactory(
  options: EmbeddedHostConnectionOptions,
): AgentHostConnectionFactory {
  return (handlers) => new EmbeddedHostConnection(handlers, options);
}

function describeStartupError(
  options: EmbeddedHostConnectionOptions,
  error: unknown,
) {
  return new Error([
    `could not start the local-agent Host (${options.command}):`,
    `${toError(error).message}.`,
    'Start `pinpawo tui` so the launcher can pass the Host runtime,',
    'or set PINPAWO_EMBED_HOST_COMMAND and PINPAWO_EMBED_HOST_ARGS.',
  ].join(' '));
}

function readChunk(chunk: string | Buffer) {
  return typeof chunk === 'string' ? chunk : chunk.toString('utf8');
}

function stripCarriageReturn(line: string) {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function isChildExited(child: EmbeddedHostChild) {
  return child.exitCode !== null || child.signalCode !== null;
}

function killChild(child: EmbeddedHostChild) {
  if (isChildExited(child)) return;
  try {
    child.kill('SIGTERM');
  } catch {
    // A Host that already exited between the check and the signal is done.
  }
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}
