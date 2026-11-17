import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { cases, fixtureVersion } from '../src/head-eval/cases';
import { score, summarize } from '../src/head-eval/scorer';
import type { HeadDecisionDiagnostic } from '../../../packages/studio/src/host/petHead';

for (const key of ['LANGCHAIN_TRACING', 'LANGCHAIN_TRACING_V2', 'LANGSMITH_TRACING', 'LANGSMITH_TRACING_V2', 'LANGFUSE_TRACING_ENABLED']) process.env[key] = 'false';

async function main() {
  const args = process.argv.slice(2), options = new Map<string, string>();
  let live = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--live' && !live) { live = true; continue; }
    if (!['--profile', '--repeats', '--cases', '--output'].includes(key) || options.has(key) || !args[i + 1] || args[i + 1]!.startsWith('--')) throw new Error('arguments');
    options.set(key, args[++i]!);
  }
  if (!live) throw new Error('explicit-live-opt-in-required');
  const profile = options.get('--profile') ?? '';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(profile)) throw new Error('profile-required');
  const repeats = Number(options.get('--repeats') ?? '1');
  const ids = options.get('--cases')?.split(',');
  if (ids?.some(id => !cases.some(test => test.id === id))) throw new Error('unknown-case');
  const selected = cases.filter(test => !ids || ids.includes(test.id));
  if (!Number.isInteger(repeats) || repeats < 1 || selected.length * repeats > 20) throw new Error('maximum-20-decisions');
  const output = options.get('--output');
  if (!output) throw new Error('output-required');
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const originalConsole = { ...console }, originalFetch = globalThis.fetch;
  for (const key of ['log', 'info', 'warn', 'error', 'debug'] as const) console[key] = () => {};
  let calls = 0;
  const report = { schemaVersion: 1, fixtureVersion, commit, profile, model: '',
    startedAt: new Date().toISOString(), providerCalls: 0, providerCallLimit: 20,
    rows: [] as Array<{ case: string; kind: 'contrast' | 'organic'; repeat: number; attempts: number; outcome?: string; code?: string; decision?: { action: string; hasReply: boolean; hasIntent: boolean; timing: string }; score: ReturnType<typeof score> }>,
    summary: {} as ReturnType<typeof summarize> | object };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 240_000);
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    // Read the existing configured profile only; no credentials or model configuration written.
    const { buildLocalModelProfileRegistry } = await import('../../../services/host/src/config/llmConfig');
    const { buildModel } = await import('../../../services/host/src/agent/agentModels');
    const { createHeadDecision } = await import('../../../packages/studio/src/host/petHead');
    const config = buildLocalModelProfileRegistry().resolve(profile);
    if (config.apiKey && (profile.includes(config.apiKey) || config.model.includes(config.apiKey))) throw new Error('unsafe-label');
    report.model = config.model;
    globalThis.fetch = async (url, init) => {
      if (controller.signal.aborted || calls >= 20) throw new Error('eval-budget');
      calls++;
      return originalFetch(url, { ...init, signal: AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]) });
    };
    for (let repeat = 1; repeat <= repeats; repeat++) for (const test of selected) {
      let diagnostic: HeadDecisionDiagnostic | undefined;
      const decide = createHeadDecision({
        profileId: profile, protocol: config.protocol ?? 'openai-compatible', model: config.model,
        baseUrl: config.baseUrl, apiKey: config.apiKey, structuredOutputMethod: config.structuredOutputMethod ?? 'jsonMode',
        createChatModel: options => buildModel({ ...config, maxOutputTokens: options.maxOutputTokens, maxRetries: options.maxRetries }, options),
      }, { onDiagnostic: value => { diagnostic = value; } });
      let decision;
      try {
        if (controller.signal.aborted || calls >= 20) throw new Error('budget');
        decision = await decide(test.input, AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]));
      } catch { /* No raw provider errors or model reasoning in reports. */ }
      const failure = controller.signal.aborted ? 'cancelled-or-deadline' : calls >= 20 && !decision ? 'call-budget' : diagnostic?.code ?? 'provider-or-transport-error';
      report.rows.push({ case: test.id, kind: test.kind, repeat, attempts: diagnostic?.attempts ?? 0,
        ...(diagnostic ? { outcome: diagnostic.outcome, ...(diagnostic.code ? { code: diagnostic.code } : {}) } : {}),
        ...(decision ? { decision: { action: decision.action, hasReply: !!decision.reply.trim(), hasIntent: !!decision.intent.trim(), timing: decision.timing } } : {}),
        score: score(test, decision, failure) });
    }
  } catch {
    // Configuration failures count in the full denominator too.
    for (let repeat = 1; repeat <= repeats; repeat++) for (const test of selected) {
      if (!report.rows.some(row => row.case === test.id && row.repeat === repeat)) report.rows.push({ case: test.id, kind: test.kind, repeat, attempts: 0, score: score(test, undefined, 'setup-error') });
    }
  } finally {
    clearTimeout(timer); process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    globalThis.fetch = originalFetch;
    Object.assign(console, originalConsole);
  }
  report.providerCalls = calls;
  report.summary = summarize(report.rows);
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ fixtureVersion, providerCalls: calls, summary: report.summary }));
  if (report.rows.some(row => !row.score.pass)) process.exitCode = 1;
}
main().catch(() => { console.error('Head eval did not run or could not save its report; check arguments, existing output path and local profile configuration.'); process.exitCode = 1; });
