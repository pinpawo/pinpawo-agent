/**
 * `pinpawo exec`: run one instruction to a terminal state and exit.
 *
 * Benchmarks and scripts need "give the agent a task, wait, collect the
 * outcome", with nobody attached to answer reviews. Rather than a second
 * runtime path, exec starts the same Host as `pinpawo run --stdio` in a child
 * process and speaks the shared JSONL protocol to it, exactly as the embedded
 * terminal UI does. Every server message is kept as the run's trajectory.
 */
import { spawn } from 'node:child_process';
import { closeSync, createWriteStream, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import {
  parseAgentServerMessage,
  type AgentClientMessage,
  type AgentRuntimeEvent,
  type AgentServerMessage,
} from '@pinpawo/agent-session';

export const EXEC_STATUSES = [
  'completed',
  'waiting',
  'interrupted',
  'failed',
  'timeout',
] as const;
export type ExecStatus = typeof EXEC_STATUSES[number];

/** Exit codes a caller can branch on without parsing the result. */
export const EXEC_EXIT_CODES: Record<ExecStatus, number> = {
  completed: 0,
  failed: 1,
  interrupted: 2,
  // The run stopped on a review or a question that nobody is there to answer.
  waiting: 3,
  timeout: 124,
};

export type ExecResult = {
  status: ExecStatus;
  reply: string;
  error?: string;
  /** Kind of the pending interrupt when the run stopped waiting on one. */
  pendingInterruptKind?: string;
  /**
   * Tool calls the main agent made (Entry and Supervisor: planning, routing,
   * delegation), from its committed messages.
   */
  mainToolCalls: number;
  /**
   * Tools that ran outside those calls, mostly inside Capability subagents,
   * counted once per call id from the run's operation events.
   */
  executedToolCalls: number;
  /** `executedToolCalls` broken down by tool name. */
  executedToolCallsByName: Record<string, number>;
  durationMs: number;
  usage?: unknown;
};

/** The child Host as exec sees it: two pipes and a way to stop it. */
export type ExecHostProcess = {
  stdin: Writable;
  stdout: Readable;
  exited: Promise<unknown>;
  kill: () => void;
};

export type ExecSessionOptions = {
  instruction: string;
  timeoutMs?: number;
  /** Receives every parsed server message, in arrival order. */
  onMessage?: (message: AgentServerMessage) => void;
  now?: () => number;
};

const SESSION_REQUEST_ID = 'exec-session';
const RUN_REQUEST_ID = 'exec-run';
/** After a timeout interrupt, how long the run may take to settle. */
const INTERRUPT_GRACE_MS = 15_000;

function send(host: ExecHostProcess, message: AgentClientMessage) {
  host.stdin.write(`${JSON.stringify(message)}\n`);
}

function readServerRecord(raw: unknown): AgentServerMessage | null {
  return raw && typeof raw === 'object' && typeof (raw as { type?: unknown }).type === 'string'
    ? raw as AgentServerMessage
    : null;
}

/**
 * Drive one fresh session through one chat request. Resolves when the run
 * reaches a terminal event, the Host exits, or the timeout elapses.
 */
export function runExecSession(
  host: ExecHostProcess,
  options: ExecSessionOptions,
): Promise<ExecResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const mainCallIds = new Set<string>();
  let mainToolCalls = 0;
  const executed = new Map<string, string>();
  let buffer = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  return new Promise<ExecResult>((resolve) => {
    let settled = false;
    type Outcome = Omit<ExecResult, 'mainToolCalls' | 'executedToolCalls' | 'executedToolCallsByName' | 'durationMs'>;
    const finish = (result: Outcome) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      host.stdout.off('data', onData);
      const executedToolCallsByName: Record<string, number> = {};
      for (const [callId, name] of executed) {
        // A main-agent call can also surface as an operation; count it once.
        if (mainCallIds.has(callId)) continue;
        executedToolCallsByName[name] = (executedToolCallsByName[name] ?? 0) + 1;
      }
      resolve({
        ...result,
        mainToolCalls,
        executedToolCalls: Object.values(executedToolCallsByName).reduce((sum, count) => sum + count, 0),
        executedToolCallsByName,
        durationMs: now() - startedAt,
      });
    };

    const onRunEvent = (event: AgentRuntimeEvent) => {
      switch (event.type) {
        case 'message.tool_calls':
          for (const call of event.toolCalls ?? []) {
            mainToolCalls += 1;
            if (call.id) mainCallIds.add(call.id);
          }
          return;
        case 'operation': {
          const source = event.operation?.source;
          const callId = source?.callId ?? event.operation?.id;
          if (callId && !executed.has(callId)) {
            executed.set(callId, source?.toolName ?? event.operation.title ?? 'unknown');
          }
          return;
        }
        case 'message.completed':
          finish({
            status: timedOut ? 'timeout' : 'completed',
            reply: typeof event.text === 'string' ? event.text : '',
            ...(event.usage ? { usage: event.usage } : {}),
          });
          return;
        case 'interrupt.requested':
          finish({
            status: timedOut ? 'timeout' : 'waiting',
            reply: '',
            pendingInterruptKind: event.pendingInterrupt?.payload?.kind,
            ...(event.usage ? { usage: event.usage } : {}),
          });
          return;
        case 'run.interrupted':
          finish({ status: timedOut ? 'timeout' : 'interrupted', reply: '', error: event.message });
          return;
        case 'error':
          finish({ status: timedOut ? 'timeout' : 'failed', reply: '', error: event.message });
          return;
        default:
          return;
      }
    };

    const onMessage = (message: AgentServerMessage) => {
      options.onMessage?.(message);
      if (message.type === 'session.new.result' && message.requestId === SESSION_REQUEST_ID) {
        send(host, { type: 'chat_request', requestId: RUN_REQUEST_ID, message: options.instruction });
        return;
      }
      if (message.type === 'session.error' && message.requestId === SESSION_REQUEST_ID) {
        finish({ status: 'failed', reply: '', error: message.message });
        return;
      }
      if (message.type === 'event' && message.requestId === RUN_REQUEST_ID) {
        onRunEvent(message.event);
      }
    };

    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          let raw: unknown;
          try {
            raw = JSON.parse(line);
          } catch {
            raw = null;
          }
          // Validation guards rendering, not routing: a terminal event that a
          // stricter parser rejects must still end the run, never hang it.
          const message = raw === null
            ? null
            : parseAgentServerMessage(raw) ?? readServerRecord(raw);
          if (message) onMessage(message);
        }
        newline = buffer.indexOf('\n');
      }
    };

    host.stdout.on('data', onData);
    void host.exited.then(() => {
      finish({ status: timedOut ? 'timeout' : 'failed', reply: '', error: 'Host exited before the run finished.' });
    });

    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        send(host, { type: 'run.interrupt', requestId: RUN_REQUEST_ID });
        timer = setTimeout(() => {
          finish({ status: 'timeout', reply: '', error: 'Run did not settle after the timeout interrupt.' });
        }, INTERRUPT_GRACE_MS);
      }, options.timeoutMs);
    }

    send(host, { type: 'session.new', requestId: SESSION_REQUEST_ID });
  });
}

export type ExecCommandOptions = {
  instruction: string;
  workdir?: string;
  /** Overrides the configured tool authorization policy for this run only. */
  approval?: string;
  timeoutMs?: number;
  /** Write every server message as JSONL. */
  trajectoryPath?: string;
  /** Write the ExecResult as JSON. */
  outputPath?: string;
  json?: boolean;
};

function ensureParent(path: string) {
  mkdirSync(dirname(path), { recursive: true });
}

/** Start `<this entry> run --stdio` as a child, the same Host the TUI embeds. */
function spawnHost(options: ExecCommandOptions): ExecHostProcess {
  const entry = process.argv[1];
  if (!entry) throw new Error('Cannot resolve the pinpawo entry to start the Host.');
  const needsLoader = !/\.[cm]?js$/.test(entry);
  const child = spawn(process.execPath, [
    ...(needsLoader ? process.execArgv : []),
    entry,
    'run',
    '--stdio',
    ...(options.workdir ? ['--workdir', options.workdir] : []),
  ], {
    env: {
      ...process.env,
      ...(options.approval ? { PINPAWO_GLOBAL_REVIEW_POLICY: options.approval } : {}),
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const exited = new Promise<unknown>((resolve) => {
    child.once('exit', resolve);
    child.once('error', resolve);
  });
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    exited,
    kill: () => { child.kill('SIGTERM'); },
  };
}

export async function runExec(
  options: ExecCommandOptions,
  /** Replaces the child Host in tests. */
  spawnHostProcess?: (options: ExecCommandOptions) => ExecHostProcess,
): Promise<ExecResult> {
  if (options.approval !== undefined) {
    const { resolveToolAuthorizationMode } = await import('../config/config');
    if (!resolveToolAuthorizationMode(options.approval)) {
      throw new Error(`Unknown --approval policy "${options.approval}". Use full-access, auto, or require.`);
    }
  }
  // Every output path is prepared before the Host starts, so a bad path
  // fails fast instead of leaving a Host behind.
  if (options.outputPath) {
    ensureParent(options.outputPath);
    closeSync(openSync(options.outputPath, 'w'));
  }
  let trajectory: ReturnType<typeof createWriteStream> | undefined;
  if (options.trajectoryPath) {
    ensureParent(options.trajectoryPath);
    trajectory = createWriteStream(options.trajectoryPath, { fd: openSync(options.trajectoryPath, 'w') });
    trajectory.on('error', (error) => {
      process.stderr.write(`[exec] trajectory write failed: ${error.message}\n`);
    });
  }

  let host: ExecHostProcess;
  try {
    host = (spawnHostProcess ?? spawnHost)(options);
  } catch (error) {
    trajectory?.destroy();
    throw error;
  }
  let result: ExecResult;
  try {
    result = await runExecSession(host, {
      instruction: options.instruction,
      timeoutMs: options.timeoutMs,
      onMessage: (message) => { trajectory?.write(`${JSON.stringify(message)}\n`); },
    });
  } finally {
    // Closing stdin is the Host's shutdown signal; kill only if it lingers.
    host.stdin.end();
    const lingering = setTimeout(() => host.kill(), 10_000);
    await host.exited;
    clearTimeout(lingering);
    await new Promise<void>((resolve) => {
      if (trajectory) trajectory.end(resolve);
      else resolve();
    });
  }

  if (options.outputPath) {
    writeFileSync(options.outputPath, `${JSON.stringify(result, null, 2)}\n`);
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    if (result.reply) process.stdout.write(`${result.reply}\n`);
    if (result.status !== 'completed') {
      process.stderr.write(
        `[exec] status=${result.status}`
        + (result.pendingInterruptKind ? ` interrupt=${result.pendingInterruptKind}` : '')
        + (result.error ? ` error=${result.error}` : '')
        + '\n',
      );
    }
  }
  process.exitCode = EXEC_EXIT_CODES[result.status];
  return result;
}
