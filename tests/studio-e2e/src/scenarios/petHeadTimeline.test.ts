import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createDeterministicScenarioModel, runPetHeadTimelineTrial, type PetHeadTimelineTrialResult } from './petHeadTimeline';

test('Pet Head timeline scenarios replay three fresh deterministic trials through production composition', { timeout: 120_000 }, async () => {
  const startedAt = new Date().toISOString();
  const trials: PetHeadTimelineTrialResult[] = [];
  const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
  const reportPath = process.env.STUDIO_SCENARIO_REPORT ?? path.join(packageRoot, 'artifacts', 'pet-head-scenarios', 'offline-report.json');
  let commit = 'unknown';
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: packageRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* Fixed safe fallback. */ }
  try {
    for (let trial = 1; trial <= 3; trial++) {
      let model: Awaited<ReturnType<typeof createDeterministicScenarioModel>> | undefined;
      let result: PetHeadTimelineTrialResult;
      try {
        model = await createDeterministicScenarioModel();
        result = await runPetHeadTimelineTrial({ trial, model });
      } catch {
        result = { trial, cases: [
          { id: 'first-tool-call', status: 'failed', checks: {}, observations: {}, failure: 'scenario-failed' },
          { id: 'referenced-follow-up', status: 'blocked', checks: {}, observations: {}, failure: 'prerequisite-failed' },
          { id: 'cross-channel-head-isolation', status: 'blocked', checks: {}, observations: {}, failure: 'prerequisite-failed' },
        ] };
      }
      try { await model?.close(); } catch {
        result.cases.at(-1)!.status = 'failed';
        result.cases.at(-1)!.failure = 'scenario-failed';
        result.cases.at(-1)!.checks.modelFixtureClosed = false;
      }
      trials.push(result);
    }
  } finally {
    const report = {
      schemaVersion: 1, suite: 'pet-head-timeline', commit, mode: 'deterministic',
      modelProfile: { id: 'scripted-openai', model: 'scenario-fixture' }, startedAt, trialCount: trials.length, trials,
    };
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  assert.equal(trials.length, 3);
  assert.deepEqual(trials.flatMap(trial => trial.cases.filter(result => result.status !== 'passed').map(result => ({ trial: trial.trial, ...result }))), []);
});

test('a rejected Head model request reports failed and blocked cases without hiding isolation results', { timeout: 10_000 }, async () => {
  const server = createServer((_request, response) => {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Synthetic model rejection.' } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const result = await runPetHeadTimelineTrial({ trial: 1,
      model: { baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'rejected-fixture' }, timeoutMs: 3_000 });
    assert.deepEqual(result.cases.map(item => item.status), ['failed', 'blocked', 'passed']);
    assert.equal(result.cases[0]!.checks.headDecisionSucceeded, false);
    assert.equal(result.cases[0]!.observations.headFailures, 1);
    assert.equal(JSON.stringify(result).includes('Synthetic model rejection'), false);
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  }
});
