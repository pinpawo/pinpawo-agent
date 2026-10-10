/**
 * A minimal outcome benchmark: give an agent a task in a scratch directory,
 * then let the task's own verifier decide pass or fail.
 *
 * Task directories follow the Harbor / Terminal-Bench layout so the same
 * tasks and habits carry over to the real benchmarks:
 *
 *   <task>/instruction.md        what the agent is told
 *   <task>/task.toml             optional [agent] / [verifier] timeout_sec
 *   <task>/environment/setup.sh  prepares the scratch directory (local stand-in for the Dockerfile)
 *   <task>/tests/test.sh         verifier; exit 0 means the task is solved
 *   <task>/solution/solve.sh     reference solution, run by the `oracle` agent
 *
 * Every script runs with the scratch directory as cwd and `TASK_DIR` set to
 * the task directory. Runs are sequential: some tasks bind fixed ports.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export type BenchTask = {
  id: string;
  dir: string;
  instruction: string;
  agentTimeoutSec: number;
  verifierTimeoutSec: number;
};

export type AgentOutcome = {
  /** `completed` for the oracle; otherwise the agent's own terminal status. */
  status: string;
  toolCalls?: number;
  error?: string;
};

export type BenchAgentContext = {
  task: BenchTask;
  workdir: string;
  /** Directory for this run's agent logs and artifacts. */
  runDir: string;
};

export type BenchAgent = {
  name: string;
  run: (context: BenchAgentContext) => Promise<AgentOutcome>;
};

export type BenchRunResult = {
  task: string;
  attempt: number;
  passed: boolean;
  agentStatus: string;
  toolCalls?: number;
  agentError?: string;
  verifierExitCode: number | null;
  agentDurationMs: number;
  workdir: string;
};

export type BenchSummary = {
  agent: string;
  startedAt: string;
  tasks: number;
  runs: number;
  passed: number;
  passRate: number;
  results: BenchRunResult[];
};

const DEFAULT_AGENT_TIMEOUT_SEC = 900;
const DEFAULT_VERIFIER_TIMEOUT_SEC = 120;

/** Reads `timeout_sec` under a TOML section; the only keys the runner needs. */
export function readTomlTimeout(toml: string, section: string): number | undefined {
  let current = '';
  for (const rawLine of toml.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      current = header[1].trim();
      continue;
    }
    const entry = /^timeout_sec\s*=\s*([0-9.]+)$/.exec(line);
    if (entry && current === section) return Number(entry[1]);
  }
  return undefined;
}

export function loadBenchTasks(tasksDir: string, only: string[] = []): BenchTask[] {
  const root = resolve(tasksDir);
  const ids = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, 'instruction.md')))
    .map((entry) => entry.name)
    .sort();
  const unknown = only.filter((id) => !ids.includes(id));
  if (unknown.length) throw new Error(`Unknown task(s): ${unknown.join(', ')}`);
  return ids
    .filter((id) => only.length === 0 || only.includes(id))
    .map((id) => {
      const dir = join(root, id);
      const tomlPath = join(dir, 'task.toml');
      const toml = existsSync(tomlPath) ? readFileSync(tomlPath, 'utf8') : '';
      return {
        id,
        dir,
        instruction: readFileSync(join(dir, 'instruction.md'), 'utf8').trim(),
        agentTimeoutSec: readTomlTimeout(toml, 'agent') ?? DEFAULT_AGENT_TIMEOUT_SEC,
        verifierTimeoutSec: readTomlTimeout(toml, 'verifier') ?? DEFAULT_VERIFIER_TIMEOUT_SEC,
      };
    });
}

export type ProcessResult = { exitCode: number | null; timedOut: boolean };

/** Run a command to completion, teeing output to a log file. */
export function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutSec: number; logPath: string },
): Promise<ProcessResult> {
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = [];
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, options.timeoutSec * 1000);
    const done = (exitCode: number | null) => {
      clearTimeout(timer);
      writeFileSync(options.logPath, Buffer.concat(chunks));
      resolvePromise({ exitCode, timedOut });
    };
    child.once('error', (error) => {
      chunks.push(Buffer.from(`${error.message}\n`));
      done(null);
    });
    child.once('close', (code) => done(code));
  });
}

function taskEnv(task: BenchTask) {
  return { TASK_DIR: task.dir };
}

/** Runs the task's reference solution; proves the task and its verifier agree. */
export const oracleAgent: BenchAgent = {
  name: 'oracle',
  async run({ task, workdir, runDir }) {
    const solve = join(task.dir, 'solution', 'solve.sh');
    if (!existsSync(solve)) return { status: 'failed', error: 'task has no solution/solve.sh' };
    const result = await runProcess('bash', [solve], {
      cwd: workdir,
      env: taskEnv(task),
      timeoutSec: task.agentTimeoutSec,
      logPath: join(runDir, 'agent.log'),
    });
    if (result.timedOut) return { status: 'timeout' };
    return result.exitCode === 0 ? { status: 'completed' } : { status: 'failed', error: `solve.sh exited ${result.exitCode}` };
  },
};

/** Leaves the environment untouched; every task must fail under it. */
export const nopAgent: BenchAgent = {
  name: 'nop',
  async run() {
    return { status: 'completed' };
  },
};

export type PinpawoAgentOptions = {
  /** Command and leading args that start the pinpawo CLI. */
  command: string[];
  approval: string;
};

/** Runs `pinpawo exec` once per task; the Host itself enforces the timeout. */
export function createPinpawoAgent(options: PinpawoAgentOptions): BenchAgent {
  return {
    name: 'pinpawo',
    async run({ task, workdir, runDir }) {
      const outputPath = join(runDir, 'exec.json');
      const [command, ...leading] = options.command;
      const result = await runProcess(command, [
        ...leading,
        'exec',
        task.instruction,
        '--workdir', workdir,
        '--approval', options.approval,
        '--timeout', String(task.agentTimeoutSec),
        '--trajectory', join(runDir, 'trajectory.jsonl'),
        '--output', outputPath,
      ], {
        cwd: workdir,
        // Grace beyond the run timeout for the interrupt to settle and the Host to exit.
        timeoutSec: task.agentTimeoutSec + 60,
        logPath: join(runDir, 'agent.log'),
      });
      if (!existsSync(outputPath)) {
        return {
          status: result.timedOut ? 'timeout' : 'failed',
          error: `pinpawo exec exited ${result.exitCode} without a result; see agent.log`,
        };
      }
      const exec = JSON.parse(readFileSync(outputPath, 'utf8')) as {
        status: string;
        toolCalls?: number;
        error?: string;
        pendingInterruptKind?: string;
      };
      return {
        status: exec.status,
        toolCalls: exec.toolCalls,
        error: exec.error ?? (exec.pendingInterruptKind ? `stopped on ${exec.pendingInterruptKind}` : undefined),
      };
    },
  };
}

export type RunBenchOptions = {
  agent: BenchAgent;
  tasks: BenchTask[];
  attempts: number;
  outDir: string;
  /** Called after each run, e.g. to print progress. */
  onResult?: (result: BenchRunResult) => void;
};

export async function runBench(options: RunBenchOptions): Promise<BenchSummary> {
  const startedAt = new Date().toISOString();
  mkdirSync(options.outDir, { recursive: true });
  const results: BenchRunResult[] = [];

  for (const task of options.tasks) {
    for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
      const runDir = join(options.outDir, task.id, String(attempt));
      mkdirSync(runDir, { recursive: true });
      const workdir = mkdtempSync(join(tmpdir(), `pinpawo-bench-${task.id}-`));
      const env = taskEnv(task);

      const setupPath = join(task.dir, 'environment', 'setup.sh');
      if (existsSync(setupPath)) {
        const setup = await runProcess('bash', [setupPath], {
          cwd: workdir,
          env,
          timeoutSec: task.verifierTimeoutSec,
          logPath: join(runDir, 'setup.log'),
        });
        if (setup.exitCode !== 0) {
          throw new Error(`setup.sh failed for ${task.id}; see ${join(runDir, 'setup.log')}`);
        }
      }

      const agentStartedAt = Date.now();
      const outcome = await options.agent.run({ task, workdir, runDir });
      const agentDurationMs = Date.now() - agentStartedAt;

      const verifier = await runProcess('bash', [join(task.dir, 'tests', 'test.sh')], {
        cwd: workdir,
        env,
        timeoutSec: task.verifierTimeoutSec,
        logPath: join(runDir, 'verifier.log'),
      });

      const result: BenchRunResult = {
        task: task.id,
        attempt,
        passed: verifier.exitCode === 0 && !verifier.timedOut,
        agentStatus: outcome.status,
        ...(outcome.toolCalls !== undefined ? { toolCalls: outcome.toolCalls } : {}),
        ...(outcome.error ? { agentError: outcome.error } : {}),
        verifierExitCode: verifier.exitCode,
        agentDurationMs,
        workdir,
      };
      writeFileSync(join(runDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
      results.push(result);
      options.onResult?.(result);
    }
  }

  const passed = results.filter((result) => result.passed).length;
  const summary: BenchSummary = {
    agent: options.agent.name,
    startedAt,
    tasks: options.tasks.length,
    runs: results.length,
    passed,
    passRate: results.length ? passed / results.length : 0,
    results,
  };
  writeFileSync(join(options.outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(options.outDir, 'summary.md'), formatSummary(summary));
  return summary;
}

export function formatSummary(summary: BenchSummary): string {
  const lines = [
    `# Bench: ${summary.agent}`,
    '',
    `Passed ${summary.passed}/${summary.runs} runs (${(summary.passRate * 100).toFixed(1)}%) across ${summary.tasks} tasks, started ${summary.startedAt}.`,
    '',
    '| task | attempt | passed | agent status | tool calls | agent time (s) | note |',
    '|---|---|---|---|---|---|---|',
    ...summary.results.map((result) => [
      result.task,
      result.attempt,
      result.passed ? 'yes' : 'no',
      result.agentStatus,
      result.toolCalls ?? '',
      (result.agentDurationMs / 1000).toFixed(1),
      (result.agentError ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 120),
    ].join(' | ')).map((row) => `| ${row} |`),
    '',
  ];
  return lines.join('\n');
}
