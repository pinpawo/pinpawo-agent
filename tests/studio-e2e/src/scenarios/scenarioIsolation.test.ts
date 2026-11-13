import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const runner = fileURLToPath(new URL('../../scripts/petHeadTimelineLive.ts', import.meta.url));

test('scenario bootstrap replaces implicit personal configuration reads before Host import', () => {
  const isolation = new URL('./isolateScenarioConfig.ts', import.meta.url).href;
  const hostConfig = new URL('../../../../services/host/src/config/config.ts', import.meta.url).href;
  const source = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { homedir } from 'node:os';
    import path from 'node:path';
    const protectedFiles = new Set([
      path.resolve(homedir(), '.pinpawo', 'config.json'),
      path.resolve(homedir(), '.pinpawo', '.env'), path.resolve(process.cwd(), '.env'),
    ]);
    let delegatedReads = 0;
    const read = fs.readFileSync;
    fs.readFileSync = function(file, ...args) {
      if (typeof file === 'string' && protectedFiles.has(path.resolve(file))) {
        delegatedReads++;
        throw new Error('Personal configuration must not be read.');
      }
      return Reflect.apply(read, fs, [file, ...args]);
    };
    syncBuiltinESMExports();
    const { scenarioConfigIsolationStats } = await import(${JSON.stringify(isolation)});
    const { getConfig } = await import(${JSON.stringify(hostConfig)});
    const selected = getConfig().modelProfileId;
    process.stdout.write(JSON.stringify({ delegatedReads, selected, ...scenarioConfigIsolationStats() }));
  `;
  const child = spawnSync(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '--eval', source], {
    cwd: packageRoot, encoding: 'utf8', timeout: 20_000,
  });
  assert.equal(child.status, 0, 'the isolated Host config must load without operator files');
  const result = JSON.parse(child.stdout);
  assert.equal(result.delegatedReads, 0);
  assert.equal(result.selected, 'scenario-bootstrap');
  assert.ok(result.personalConfigReadsReplaced >= 1);
  assert.ok(result.dotenvReadsBlocked >= 2);
});

test('live runner refuses implicit opt-in and credential-shaped report labels without echoing them', () => {
  const credential = 'scenario-secret-only-for-boundary-test';
  const invoke = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx/esm', runner, ...args], {
    cwd: packageRoot, encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, SCENARIO_BOUNDARY_TEST_KEY: credential },
  });
  const noOptIn = invoke([]);
  assert.notEqual(noOptIn.status, 0);
  assert.equal(JSON.parse(noOptIn.stderr.trim()).failure, 'live-runner-error');
  const badLabel = invoke(['--live', '--base-url', 'https://provider.example.test/v1',
    '--model', 'scenario-model', '--profile', credential, '--api-key-env', 'SCENARIO_BOUNDARY_TEST_KEY']);
  assert.notEqual(badLabel.status, 0);
  assert.equal(JSON.parse(badLabel.stderr.trim()).failure, 'live-runner-error');
  assert.equal((badLabel.stdout + badLabel.stderr).includes(credential), false);
});

test('live cancellation records all requested trials without contacting a provider', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scenario-cancel-'));
  const preload = path.join(root, 'mock-transport.mjs');
  const reportPath = path.join(root, 'report.json');
  await writeFile(preload, `
    const transport = globalThis.fetch;
    globalThis.fetch = (url, options) => {
      if (new URL(String(url)).hostname !== 'provider.example.test') return transport(url, options);
      process.stdout.write('scenario-transport-started\\n');
      return new Promise((_resolve, reject) => {
        const fail = () => reject(new Error('Cancelled synthetic transport.'));
        if (options.signal.aborted) fail();
        else options.signal.addEventListener('abort', fail, { once: true });
      });
    };
  `);
  const child = spawn(process.execPath, ['--import', preload, '--import', 'tsx/esm', runner,
    '--live', '--base-url', 'https://provider.example.test/v1', '--model', 'scenario-model',
    '--profile', 'cancel-fixture', '--api-key-env', 'SCENARIO_BOUNDARY_TEST_KEY',
    '--trials', '3', '--output', reportPath], {
    cwd: packageRoot, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SCENARIO_BOUNDARY_TEST_KEY: 'cancellation-test-only-credential' },
  });
  let output = '';
  let signalled = false;
  child.stdout.on('data', data => {
    output += String(data);
    if (!signalled && output.includes('scenario-transport-started')) { signalled = true; child.kill('SIGTERM'); }
  });
  let stderr = '';
  child.stderr.on('data', data => { stderr += String(data); });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 20_000);
  try {
    const exit = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => resolve(code));
    });
    assert.equal(exit, 1, 'cancelled execution must not report success');
    assert.equal(stderr, '');
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.equal(report.cancelled, true);
    assert.equal(report.trialCount, 3);
    assert.equal(report.trials.length, 3);
    assert.equal(report.trials.flatMap((trial: { cases: unknown[] }) => trial.cases).length, 9);
    assert.ok(report.trials.every((trial: { cases: Array<{ status: string }> }) => trial.cases.every(result => result.status !== 'passed')));
    assert.equal(JSON.stringify(report).includes('cancellation-test-only-credential'), false);
  } finally {
    clearTimeout(watchdog);
    child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});
