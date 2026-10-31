/**
 * Channel routing eval: does the decider wake the right Pet, and only when one should answer?
 *
 * Each case is an unaddressed human message with its recent public history in a
 * Channel of Executor, Reviewer and Wiki. The routing threshold applies as in the
 * Channel plugin. A Pet run costs far more than a missed route, so the report
 * counts false wakes (routed when nobody should answer) apart from misses.
 *
 * Env:
 *   ROUTING_EVAL_MODEL_PROFILE_ID  Model profile from ~/.pinpawo/config.json.
 *                                  Falls back to PROMPT_EVAL_MODEL_PROFILE_ID.
 *   ROUTING_EVAL_REPEATS           Runs per case (default 3).
 *   ROUTING_EVAL_THRESHOLD         Overrides the default llm threshold.
 *
 * Run:
 *   ROUTING_EVAL_MODEL_PROFILE_ID=deepseek-v4-flash npm run eval:channel-routing
 */
import { buildModel } from '../../../services/host/src/agent/agentModels.ts';
import { createChannelRouter, type RouteInput } from '../../../plugins/channel/src/channelRouting.ts';
import { readResolvedProfile } from './scripts/decision-eval-model.ts';

const pets = [
  { participantId: 'pet:executor', name: 'Executor' },
  { participantId: 'pet:reviewer', name: 'Reviewer' },
  { participantId: 'pet:wiki', name: 'Wiki' },
];
const notes = {
  executor: '执行代码、命令和交付类请求；也负责回答它做过的工作的进度。',
  reviewer: '审查代码、PR 和交付结果。',
  wiki: '维护项目 Wiki 和文档。',
};
const history = [
  { author: 'Barry', body: '[@Executor](participant:pet:executor) 把 Channel 的无 @ 行为写进设计文档，开个 PR。' },
  { author: 'Executor', body: '已开 PR #1003，只改文档，CI 通过。' },
  { author: 'Alice', body: '我下午看一下登录页的样式问题。' },
  { author: 'Barry', body: '[@Reviewer](participant:pet:reviewer) 帮我看下 #998 的 contracts 改动。' },
  { author: 'Reviewer', body: '#998 看完了，有一处 assertNever 漏了 text 分支，已留言。' },
];

type Case = { id: string; body: string; expected: string; replyTo?: { author: string; body: string } };
const cases: Case[] = [
  { id: 'who-handles-pr', body: '#1003 是谁在处理的？', expected: 'pet:executor' },
  { id: 'pr-status', body: '1003 现在什么状态了，能合吗？', expected: 'pet:executor' },
  { id: 'review-followup', body: '998 那个漏掉的分支严重吗？', expected: 'pet:reviewer' },
  { id: 'new-task', body: '帮我把 README 里的安装步骤更新成 Node 24。', expected: 'pet:wiki' },
  { id: 'run-tests', body: '能在 main 上跑一下 channel 的测试吗？', expected: 'pet:executor' },
  { id: 'review-request', body: '有人能 review 一下 #1004 吗？', expected: 'pet:reviewer' },
  { id: 'reply-to-pet', body: '那就先合了吧', expected: 'pet:executor',
    replyTo: { author: 'Executor', body: '已开 PR #1003，只改文档，CI 通过。' } },
  { id: 'thanks', body: '好的，谢谢！', expected: 'none' },
  { id: 'human-chat', body: 'Alice 你下午几点有空？一起对一下登录页。', expected: 'none' },
  { id: 'lunch', body: '中午吃什么', expected: 'none' },
  { id: 'ack', body: '收到', expected: 'none' },
  { id: 'reply-to-human', body: '我三点后都行', expected: 'none',
    replyTo: { author: 'Alice', body: '我下午看一下登录页的样式问题。' } },
  { id: 'thinking-aloud', body: '嗯……我再想想这个方向', expected: 'none' },
  { id: 'emoji', body: '👍', expected: 'none' },
];

const profileId = process.env.ROUTING_EVAL_MODEL_PROFILE_ID ?? process.env.PROMPT_EVAL_MODEL_PROFILE_ID;
if (!profileId) throw new Error('Set ROUTING_EVAL_MODEL_PROFILE_ID to a model profile from ~/.pinpawo/config.json.');
const repeats = Number(process.env.ROUTING_EVAL_REPEATS ?? 3);
const threshold = process.env.ROUTING_EVAL_THRESHOLD ? Number(process.env.ROUTING_EVAL_THRESHOLD) : undefined;
const { profile, config } = readResolvedProfile(profileId, process.env);
const router = createChannelRouter({
  enabled: true, pets: notes, ...(threshold !== undefined ? { threshold } : {}),
}, {
  resolveModel: () => ({
    protocol: config.protocol, profileId, baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model,
    structuredOutputMethod: config.structuredOutputMethod ?? 'jsonMode',
    createChatModel: ({ maxOutputTokens, maxRetries, preferDeterministic, streaming, forceChatCompletions }) => buildModel({
      ...config, maxOutputTokens, maxRetries,
    }, { preferDeterministic, streaming, forceChatCompletions }),
  }),
})!;

const rows: Array<{ id: string; expected: string; got: string; ms: number; detail: string }> = [];
for (const item of cases) {
  for (let run = 0; run < repeats; run++) {
    const input: RouteInput = {
      channel: { title: 'pinpawo-agent', description: '日常开发协作' },
      message: { author: 'Barry', body: item.body, ...(item.replyTo ? { replyTo: item.replyTo } : {}) },
      pets, history,
    };
    const started = performance.now();
    const outcome = await router.decide(input);
    const ms = Math.round(performance.now() - started);
    const got = outcome.kind === 'route' ? outcome.participantId : 'none';
    const detail = outcome.kind === 'route'
      ? `${outcome.confidence} ${outcome.reason ?? ''}`
      : `${outcome.reason} ${outcome.confidence ?? ''} ${outcome.detail ?? ''}`;
    rows.push({ id: item.id, expected: item.expected, got, ms, detail: detail.trim() });
    console.log(`${got === item.expected ? 'PASS' : 'FAIL'} ${item.id}#${run + 1} expected=${item.expected} got=${got} ${ms}ms ${detail.trim()}`);
  }
}

const passed = rows.filter(row => row.got === row.expected).length;
const falseWakes = rows.filter(row => row.expected === 'none' && row.got !== 'none').length;
const misses = rows.filter(row => row.expected !== 'none' && row.got === 'none').length;
const wrongPet = rows.filter(row => row.expected !== 'none' && row.got !== 'none' && row.got !== row.expected).length;
const errors = rows.filter(row => row.detail.startsWith('error') || row.detail.startsWith('invalid')).length;
const latencies = rows.map(row => row.ms).sort((a, b) => a - b);
const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))];
console.log(JSON.stringify({
  profileId, model: profile.model, repeats, cases: cases.length,
  passed: `${passed}/${rows.length}`, falseWakes, misses, wrongPet, errors,
  latencyMs: { p50: pct(0.5), p95: pct(0.95) },
}, null, 2));
if (passed !== rows.length) process.exitCode = 1;
