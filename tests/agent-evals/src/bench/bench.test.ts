import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createPinpawoAgent,
  loadBenchTasks,
  nopAgent,
  oracleAgent,
  readTomlTimeout,
  runBench,
} from './bench';

const tasksDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bench', 'tasks');

function scratch(name: string) {
  return mkdtempSync(join(tmpdir(), `pinpawo-bench-test-${name}-`));
}

test('task.toml timeouts are read per section', () => {
  const toml = '[metadata]\ntimeout_sec = 1\n\n[agent]\ntimeout_sec = 600 # ten minutes\n\n[verifier]\ntimeout_sec = 30\n';
  assert.equal(readTomlTimeout(toml, 'agent'), 600);
  assert.equal(readTomlTimeout(toml, 'verifier'), 30);
  assert.equal(readTomlTimeout(toml, 'environment'), undefined);
});

test('unknown task ids are rejected instead of silently skipped', () => {
  assert.throws(() => loadBenchTasks(tasksDir, ['no-such-task']), /no-such-task/);
});

// The sample tasks are only meaningful if their verifiers accept the reference
// solution and reject an untouched environment.
test('every sample task passes with its reference solution', async () => {
  const tasks = loadBenchTasks(tasksDir);
  assert.ok(tasks.length >= 5);
  const summary = await runBench({ agent: oracleAgent, tasks, attempts: 1, outDir: scratch('oracle') });
  const failed = summary.results.filter((result) => !result.passed).map((result) => result.task);
  assert.deepEqual(failed, []);
});

test('every sample task fails when the agent does nothing', async () => {
  const tasks = loadBenchTasks(tasksDir);
  const summary = await runBench({ agent: nopAgent, tasks, attempts: 1, outDir: scratch('nop') });
  const passed = summary.results.filter((result) => result.passed).map((result) => result.task);
  assert.deepEqual(passed, []);
});

test('the pinpawo agent calls exec with the task and reads its result', async () => {
  const fakeCli = join(scratch('fake-cli'), 'fake-pinpawo.mjs');
  // Stands in for `pinpawo`: records its argv and reports a finished run.
  writeFileSync(fakeCli, [
    "import { writeFileSync } from 'node:fs';",
    'const args = process.argv.slice(2);',
    "const output = args[args.indexOf('--output') + 1];",
    "writeFileSync('argv.json', JSON.stringify(args));",
    "writeFileSync(output, JSON.stringify({ status: 'waiting', pendingInterruptKind: 'human_review', mainToolCalls: 2, executedToolCalls: 3 }));",
  ].join('\n'));
  const tasks = loadBenchTasks(tasksDir, ['systemd-unit']);
  const outDir = scratch('pinpawo');

  const summary = await runBench({
    agent: createPinpawoAgent({ command: [process.execPath, fakeCli], approval: 'auto' }),
    tasks,
    attempts: 1,
    outDir,
  });

  const [result] = summary.results;
  assert.equal(result.passed, false);
  assert.equal(result.agentStatus, 'waiting');
  assert.equal(result.mainToolCalls, 2);
  assert.equal(result.executedToolCalls, 3);
  assert.equal(result.agentError, 'stopped on human_review');
  const argv = JSON.parse(readFileSync(join(result.workdir, 'argv.json'), 'utf8')) as string[];
  assert.equal(argv[0], 'exec');
  assert.equal(argv[1], tasks[0].instruction);
  assert.deepEqual(argv.slice(2, 8), ['--workdir', result.workdir, '--approval', 'auto', '--timeout', '600']);
  assert.match(readFileSync(join(outDir, 'summary.md'), 'utf8'), /Passed 0\/1 runs/);
});
