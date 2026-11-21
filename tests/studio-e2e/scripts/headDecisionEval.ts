import { execFileSync } from 'node:child_process';
import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { cases, fixtureVersion } from '../src/head-eval/cases';
import { score, summarize } from '../src/head-eval/scorer';
import type { HeadDecisionDiagnostic } from '../../../packages/studio/src/host/petHeadModel';

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
  // Reserve a private new report before spending any provider calls.
  const reservation = await open(output, 'wx', 0o600);
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const originalConsole = { ...console }, originalFetch = globalThis.fetch;
  for (const key of ['log', 'info', 'warn', 'error', 'debug'] as const) console[key] = () => {};
  let calls = 0;
  type Wire = { elapsedMs: number; status: number; finishReasons: string[]; inputTokens?: number; outputTokens?: number; reasoningTokens?: number; totalTokens?: number; maxOutputTokens?: number; thinking?: string; format?: string };
  let wire: Wire[] = [];

  const report = { schemaVersion: 2, fixtureVersion, commit, profile, model: '',
    startedAt: new Date().toISOString(), providerCalls: 0, providerCallLimit: 20,
    rows: [] as Array<{ case: string; kind: 'contrast' | 'organic'; repeat: number; attempts: number; elapsedMs: number; wire: Wire[]; outcome?: string; code?: string; decision?: { action: string; hasReply: boolean }; score: ReturnType<typeof score> }>,
    summary: {} as ReturnType<typeof summarize> | object };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 240_000);
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    // Read the existing configured profile only; no credentials or model configuration written.
    const { buildLocalModelProfileRegistry } = await import('../../../services/host/src/config/llmConfig');
    const { buildModel } = await import('../../../services/host/src/agent/agentModels');
    const { createHeadModel } = await import('../../../packages/studio/src/host/petHeadModel');
    const config = buildLocalModelProfileRegistry().resolve(profile);
    if (config.apiKey && (profile.includes(config.apiKey) || config.model.includes(config.apiKey))) throw new Error('unsafe-label');
    report.model = config.model;
    globalThis.fetch = async (url, init) => {
      if (controller.signal.aborted || calls >= 20) throw new Error('eval-budget');
      calls++;
      const started = Date.now();
      let request: Record<string, any> = {};
      try { request = JSON.parse(String(init?.body)); } catch { /* No raw request retained. */ }
      let response: Response;
      try { response = await originalFetch(url, { ...init, signal: AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]) }); }
      catch { wire.push({ elapsedMs: Date.now() - started, status: 0, finishReasons: [] }); throw new Error('transport-error'); }
      const metadata: Wire = { elapsedMs: Date.now() - started, status: response.status, finishReasons: [] };
      const cap = request.max_completion_tokens ?? request.max_tokens;
      if (Number.isFinite(cap)) metadata.maxOutputTokens = cap;
      if (['enabled', 'disabled'].includes(request.thinking?.type)) metadata.thinking = request.thinking.type;
      if (['json_object', 'json_schema'].includes(request.response_format?.type)) metadata.format = request.response_format.type;
      try {
        // Production Head is nonstreaming; retain only allowlisted counters/enums.
        const body = await response.clone().json() as Record<string, any>;
        const allowed = ['stop', 'length', 'tool_calls', 'content_filter', 'end_turn', 'max_tokens', 'tool_use', 'stop_sequence'];
        const reasons = [...(Array.isArray(body.choices) ? body.choices.map((choice: any) => choice.finish_reason) : []), body.stop_reason];
        metadata.finishReasons = reasons.filter(reason => allowed.includes(reason));
        const input = body.usage?.prompt_tokens ?? body.usage?.input_tokens;
        const output = body.usage?.completion_tokens ?? body.usage?.output_tokens;
        if (Number.isFinite(input)) metadata.inputTokens = input;
        if (Number.isFinite(output)) metadata.outputTokens = output;
        const reasoning = body.usage?.completion_tokens_details?.reasoning_tokens;
        if (Number.isFinite(reasoning)) metadata.reasoningTokens = reasoning;
        if (Number.isFinite(body.usage?.total_tokens)) metadata.totalTokens = body.usage.total_tokens;
      } catch { /* Non-JSON responses remain operational status only. */ }
      metadata.elapsedMs = Date.now() - started;
      wire.push(metadata);
      return response;

    };
    for (let repeat = 1; repeat <= repeats; repeat++) for (const test of selected) {
      wire = [];
      const started = Date.now();
      let diagnostic: HeadDecisionDiagnostic | undefined;
      const { decide } = createHeadModel(() => ({
        profileId: profile, protocol: config.protocol ?? 'openai-compatible', model: config.model,
        baseUrl: config.baseUrl, apiKey: config.apiKey, structuredOutputMethod: config.structuredOutputMethod ?? 'jsonMode',
        createChatModel: options => buildModel({ ...config, maxOutputTokens: options.maxOutputTokens, maxRetries: options.maxRetries }, options),
      }), { onDiagnostic: value => { diagnostic = value; } });
      let decision;
      try {
        if (controller.signal.aborted || calls >= 20) throw new Error('budget');
        decision = await decide(test.input, AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]));
      } catch { /* No raw provider errors or model reasoning in reports. */ }
      const failure = controller.signal.aborted ? 'cancelled-or-deadline' : calls >= 20 && !decision ? 'call-budget' : diagnostic?.code ?? 'provider-or-transport-error';
      report.rows.push({ case: test.id, kind: test.kind, repeat, attempts: diagnostic?.attempts ?? 0, elapsedMs: Date.now() - started, wire: [...wire],
        ...(diagnostic ? { outcome: diagnostic.outcome, ...(diagnostic.code ? { code: diagnostic.code } : {}) } : {}),
        ...(decision ? { decision: { action: decision.action, hasReply: !!decision.reply?.trim() } } : {}),
        score: score(test, decision, failure) });
    }
  } catch {
    // Configuration failures count in the full denominator too.
    for (let repeat = 1; repeat <= repeats; repeat++) for (const test of selected) {
      if (!report.rows.some(row => row.case === test.id && row.repeat === repeat)) report.rows.push({ case: test.id, kind: test.kind, repeat, attempts: 0, elapsedMs: 0, wire: [], score: score(test, undefined, 'setup-error') });
    }
  } finally {
    clearTimeout(timer); process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    globalThis.fetch = originalFetch;
    Object.assign(console, originalConsole);
  }
  report.providerCalls = calls;
  report.summary = summarize(report.rows);
  await reservation.writeFile(JSON.stringify(report, null, 2) + '\n');
  await reservation.close();
  console.log(JSON.stringify({ fixtureVersion, providerCalls: calls, summary: report.summary }));
  if (report.rows.some(row => !row.score.pass)) process.exitCode = 1;
}
main().catch(() => { console.error('Head eval did not run or could not save its report; check arguments, existing output path and local profile configuration.'); process.exitCode = 1; });
