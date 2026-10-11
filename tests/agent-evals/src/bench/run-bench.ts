/**
 * npm run bench -w @pinpawo-tests/agent-evals -- [--agent pinpawo|oracle|nop]
 *   [--task <id>]... [--attempts N] [--approval auto|full-access|require]  (default auto)
 *   [--tasks-dir <dir>] [--out <dir>]
 *
 * The pinpawo agent uses the model profile in ~/.pinpawo/config.json. Set
 * PINPAWO_BENCH_COMMAND (JSON array) to run an installed CLI instead of this
 * checkout, e.g. '["pinpawo"]'.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  createPinpawoAgent,
  formatSummary,
  loadBenchTasks,
  nopAgent,
  oracleAgent,
  runBench,
  type BenchAgent,
} from './bench';

const here = dirname(fileURLToPath(import.meta.url));
const evalsRoot = resolve(here, '..', '..');
const repoRoot = resolve(evalsRoot, '..', '..');

function readPinpawoCommand(): string[] {
  const configured = process.env.PINPAWO_BENCH_COMMAND?.trim();
  if (configured) {
    const parsed: unknown = JSON.parse(configured);
    if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((part) => typeof part === 'string')) {
      throw new Error('PINPAWO_BENCH_COMMAND must be a JSON array of strings.');
    }
    return parsed;
  }
  // An absolute loader URL: the CLI runs with the task's scratch directory as
  // cwd, and passes its loader on to the Host it starts.
  return [
    process.execPath,
    '--import',
    import.meta.resolve('tsx/esm'),
    join(repoRoot, 'services', 'host', 'src', 'index.ts'),
  ];
}

const { values } = parseArgs({
  options: {
    agent: { type: 'string', default: 'pinpawo' },
    task: { type: 'string', multiple: true, default: [] },
    attempts: { type: 'string', default: '1' },
    approval: { type: 'string', default: 'auto' },
    'tasks-dir': { type: 'string', default: join(evalsRoot, 'bench', 'tasks') },
    out: { type: 'string' },
  },
});

const agents: Record<string, () => BenchAgent> = {
  pinpawo: () => createPinpawoAgent({ command: readPinpawoCommand(), approval: values.approval }),
  oracle: () => oracleAgent,
  nop: () => nopAgent,
};
const makeAgent = agents[values.agent];
if (!makeAgent) throw new Error(`Unknown --agent ${values.agent}; use ${Object.keys(agents).join(', ')}.`);
const attempts = Number(values.attempts);
if (!Number.isInteger(attempts) || attempts < 1) throw new Error('--attempts must be a positive integer.');

const agent = makeAgent();
const tasks = loadBenchTasks(values['tasks-dir'], values.task);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = resolve(values.out ?? join(evalsRoot, '.eval-results', 'bench', `${stamp}-${agent.name}`));

console.log(`[bench] agent=${agent.name} tasks=${tasks.length} attempts=${attempts} out=${outDir}`);
const summary = await runBench({
  agent,
  tasks,
  attempts,
  outDir,
  onResult: (result) => {
    console.log(
      `[bench] ${result.passed ? 'PASS' : 'FAIL'} ${result.task}#${result.attempt}`
      + ` agent=${result.agentStatus} ${(result.agentDurationMs / 1000).toFixed(1)}s`
      + (result.agentError ? ` (${result.agentError})` : ''),
    );
  },
});
console.log(`\n${formatSummary(summary)}`);
