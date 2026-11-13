import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PetHeadTimelineTrialResult } from '../src/scenarios/petHeadTimeline';

// Never inherit an operator's tracing destinations into a scenario run.
for (const key of ['LANGCHAIN_TRACING', 'LANGCHAIN_TRACING_V2', 'LANGSMITH_TRACING',
  'LANGSMITH_TRACING_V2', 'LANGFUSE_TRACING_ENABLED']) process.env[key] = 'false';

async function main() {
  const caseIds = ['first-tool-call', 'referenced-follow-up', 'cross-channel-head-isolation'] as const;
  const args = process.argv.slice(2);
  const options = new Map<string, string>();
  let optedIn = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (flag === '--live') { optedIn = true; continue; }
    if (!['--base-url', '--model', '--api-key-env', '--profile', '--trials', '--output'].includes(flag)
      || options.has(flag) || !args[index + 1] || args[index + 1]!.startsWith('--')) {
      throw new Error('Invalid live scenario arguments. See tests/studio-e2e/README.md.');
    }
    options.set(flag, args[++index]!);
  }
  if (!optedIn) throw new Error('Live scenarios require explicit --live opt-in.');
  const safeId = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
  const model = options.get('--model') ?? '';
  const profile = options.get('--profile') ?? '';
  const keyName = options.get('--api-key-env') ?? '';
  const baseUrl = options.get('--base-url') ?? '';
  const trialCount = Number(options.get('--trials') ?? '3');
  if (!safeId.test(model) || !safeId.test(profile) || !/^[A-Z][A-Z0-9_]{1,79}$/.test(keyName)
    || !Number.isInteger(trialCount) || trialCount < 1 || trialCount > 10 || !baseUrl) {
    throw new Error('Live scenarios require an explicit endpoint, safe model/profile IDs, key environment name and 1–10 trials.');
  }
  const apiKey = process.env[keyName] ?? '';
  if (apiKey && (profile.includes(apiKey) || model.includes(apiKey))) {
    throw new Error('A credential cannot be used as a scenario report label.');
  }

  const repository = fileURLToPath(new URL('../../..', import.meta.url));
  let commit = 'unknown';
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { /* The report remains explicit when run from an exported source tree. */ }
  const report = {
    schemaVersion: 1, suite: 'pet-head-timeline', commit, mode: 'live',
    modelProfile: { id: profile, model }, startedAt: new Date().toISOString(), trialCount,
    trials: [] as PetHeadTimelineTrialResult[],
    gateway: { requests: 0, forwarded: 0, blocked: 0, redactions: 0 },
    cancelled: false,
    configuration: { personalConfigReadsReplaced: 0, dotenvReadsBlocked: 0 },
  };
  const output = path.resolve(options.get('--output') ?? 'artifacts/pet-head-scenarios/live-report.json');
  const originalConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  for (const key of ['log', 'info', 'warn', 'error', 'debug'] as const) console[key] = () => {};
  const { createLiveScenarioGateway } = await import('../src/scenarios/liveModelGateway');
  const { runPetHeadTimelineTrial } = await import('../src/scenarios/petHeadTimeline');
  const { scenarioConfigIsolationStats } = await import('../src/scenarios/isolateScenarioConfig');
  let gateway: Awaited<ReturnType<typeof createLiveScenarioGateway>> | undefined;
  const cancellation = new AbortController();
  const cancel = () => {
    report.cancelled = true;
    cancellation.abort();
    void gateway?.close().catch(() => {});
  };
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    if (!apiKey) throw new Error('The selected live scenario credential is not configured.');
    gateway = await createLiveScenarioGateway({ baseUrl, model, apiKey,
      forbiddenRoots: [repository, process.cwd(), homedir(), tmpdir()] });
    for (let trial = 1; trial <= trialCount; trial++) {
      if (cancellation.signal.aborted) {
        report.trials.push({ trial, cases: caseIds.map(id => ({ id, status: 'blocked' as const,
          checks: {}, observations: { cancelled: true }, failure: 'prerequisite-failed' as const })) });
        continue;
      }
      try {
        report.trials.push(await runPetHeadTimelineTrial({ trial,
          model: { baseUrl: gateway.baseUrl, model: gateway.model, apiKey: gateway.apiKey },
          timeoutMs: 180_000, signal: cancellation.signal }));
      } catch {
        report.trials.push({ trial, cases: caseIds.map(id => ({ id, status: 'blocked' as const,
          checks: {}, observations: {}, failure: 'prerequisite-failed' as const })) });
      }
      originalConsole.log(JSON.stringify({ trial, cases: report.trials.at(-1)!.cases.map(result => ({ id: result.id, status: result.status })) }));
    }
  } catch {
    // Fixed codes only: provider messages can contain request data or credentials.
    for (let trial = 1; trial <= trialCount; trial++) {
      report.trials.push({ trial, cases: caseIds.map(id => ({ id, status: 'blocked' as const,
        checks: {}, observations: {}, failure: 'prerequisite-failed' as const })) });
    }
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    report.configuration = scenarioConfigIsolationStats();
    if (gateway) {
      report.gateway = { ...gateway.stats };
      try { await gateway.close(); } catch { report.gateway.blocked++; }
    }
    Object.assign(console, originalConsole);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  }
  const outcomes = report.trials.flatMap(trial => trial.cases);
  const passed = outcomes.filter(result => result.status === 'passed').length;
  console.log(JSON.stringify({ suite: report.suite, commit, mode: report.mode, profile,
    trials: report.trials.length, passed, failedOrBlocked: outcomes.length - passed,
    gatewayBlocked: report.gateway.blocked }));
  if (passed !== trialCount * caseIds.length || report.gateway.blocked) process.exitCode = 1;
}

await main().catch(() => {
  process.stderr.write(JSON.stringify({ suite: 'pet-head-timeline', status: 'failed', failure: 'live-runner-error' }) + '\n');
  process.exitCode = 1;
});
