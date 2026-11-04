/**
 * Channel routing eval: does the decider wake the right Pet, and only when one should answer?
 *
 * Each case is an unaddressed human or Pet message with its recent public history
 * in a Channel of Executor, Reviewer, Wiki and Issuer. The production routeInput
 * adapter derives identity and eligible candidates from stored member metadata;
 * selected cases then attach synthetic Host runtime observations to candidates.
 * The routing threshold applies as in the
 * Channel plugin. A Pet run costs far more than a missed route, so the report
 * counts false wakes (routed when nobody should answer) apart from misses.
 *
 * Env:
 *   ROUTING_EVAL_MODEL_PROFILE_ID  Model profile from ~/.pinpawo/config.json.
 *                                  Falls back to PROMPT_EVAL_MODEL_PROFILE_ID.
 *   ROUTING_EVAL_REPEATS           Runs per case (default 3).
 *   ROUTING_EVAL_THRESHOLD         Overrides the default llm threshold.
 *   ROUTING_EVAL_CASE_IDS          Comma-separated exact case IDs (default all).
 *   ROUTING_EVAL_OUTPUT_DIR        Save private rows.jsonl and report.json here.
 *                                  Existing result files are never overwritten.
 *   ROUTING_EVAL_LIST_CASES=1      List IDs without loading profiles or models.
 *
 * Run:
 *   ROUTING_EVAL_MODEL_PROFILE_ID=deepseek-v4-flash npm run eval:channel-routing
 */
import { chmodSync, existsSync, mkdirSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildModel } from '../../../services/host/src/agent/agentModels.ts';
import { createChannelRouter, routeInput, type RouteCandidate, type RouteInput, type RouteOutcome } from '../../../plugins/channel/src/channelRouting.ts';
import type { ChannelMember } from '../../../plugins/channel/src/channelService.ts';
import type { ChannelMessageRow } from '../../../plugins/channel/src/store/channelStore.ts';
import { readResolvedProfile } from './scripts/decision-eval-model.ts';

const members: ChannelMember[] = [
  { participantId: 'human:barry', kind: 'human', id: 'barry', label: 'Barry', joinedAt: '' },
  { participantId: 'human:alice', kind: 'human', id: 'alice', label: 'Alice', joinedAt: '' },
  ...['executor', 'reviewer', 'wiki', 'issuer'].map(id => ({
    participantId: `pet:${id}`, kind: 'pet' as const, id,
    label: id[0]!.toUpperCase() + id.slice(1), joinedAt: '',
  })),
];
const notes = {
  executor: '执行代码、命令和交付类请求；也负责回答它做过的工作的进度。',
  reviewer: '独立审查代码、PR 和交付结果是否符合人类意图，说明结论、依据、风险和需要人类决定的问题。',
  wiki: '维护项目 Wiki 和文档，说明变化、来源与不确定性。',
  issuer: '整理 Issue、跟进状态和进度，使 Issue 状态与真实交付及人类意图对齐。',
};
type AuthorIdentity = NonNullable<RouteInput['message']['authorIdentity']>;
type FixtureMessage = { authorIdentity: AuthorIdentity; body: string };
type CandidateRuntime = NonNullable<RouteCandidate['runtime']>;
type PetParticipantId = 'pet:executor' | 'pet:reviewer' | 'pet:wiki' | 'pet:issuer';
const runtime = (overrides: Partial<CandidateRuntime> = {}): CandidateRuntime => ({
  sampledAt: '2026-01-01T00:00:00.000Z', sessionState: 'idle', admissionState: 'open',
  activeScope: 'none', queuedInSession: 0, ...overrides,
});
const identity = (participantId: string): AuthorIdentity => {
  const member = members.find(item => item.participantId === participantId);
  if (!member) throw new Error(`Unknown fixture participant: ${participantId}`);
  return { participantId, kind: member.kind };
};
const message = (participantId: string, body: string): FixtureMessage => ({ authorIdentity: identity(participantId), body });
const history: FixtureMessage[] = [
  message('human:barry', '[@Executor](participant:pet:executor) 把 Channel 的无 @ 行为写进设计文档，开个 PR。'),
  message('pet:executor', '已开 PR #1003，只改文档，CI 通过。'),
  message('human:alice', '我下午看一下登录页的样式问题。'),
  message('human:barry', '[@Reviewer](participant:pet:reviewer) 帮我看下 #998 的 contracts 改动。'),
  message('pet:reviewer', '#998 看完了，有一处 assertNever 漏了 text 分支，已留言。'),
];

type Case = {
  id: string;
  body: string;
  expected: string;
  authorIdentity?: AuthorIdentity;
  history?: FixtureMessage[];
  channelPrompt?: string;
  replyTo?: FixtureMessage;
  petRuntime?: Partial<Record<PetParticipantId, CandidateRuntime>>;
};
const collaborationPrompt = 'Issuer 负责 Issue 状态和进度；Executor 负责实现与自测；Reviewer 负责独立审查交付；Wiki 维护项目知识。依据实际差异协作，复用已有结论。需要人类决定时说明待决事项，没有新问题时收口。草稿、已审查、已合并和已部署是不同状态。';
const cases: Case[] = [
  { id: 'who-handles-pr', body: '#1003 是谁在处理的？', expected: 'pet:executor' },
  { id: 'pr-status', body: '1003 现在什么状态了，能合吗？', expected: 'pet:executor' },
  { id: 'review-followup', body: '998 那个漏掉的分支严重吗？', expected: 'pet:reviewer' },
  { id: 'new-task', body: '帮我把 README 里的安装步骤更新成 Node 24。', expected: 'pet:wiki' },
  { id: 'run-tests', body: '能在 main 上跑一下 channel 的测试吗？', expected: 'pet:executor' },
  { id: 'review-request', body: '有人能 review 一下 #1004 吗？', expected: 'pet:reviewer' },
  { id: 'reply-to-pet', body: '那就先合了吧', expected: 'pet:executor',
    replyTo: message('pet:executor', '已开 PR #1003，只改文档，CI 通过。') },
  { id: 'thanks', body: '好的，谢谢！', expected: 'none' },
  { id: 'human-chat', body: 'Alice 你下午几点有空？一起对一下登录页。', expected: 'none' },
  { id: 'lunch', body: '中午吃什么', expected: 'none' },
  { id: 'ack', body: '收到', expected: 'none' },
  { id: 'reply-to-human', body: '我三点后都行', expected: 'none',
    replyTo: message('human:alice', '我下午看一下登录页的样式问题。') },
  { id: 'thinking-aloud', body: '嗯……我再想想这个方向', expected: 'none' },
  { id: 'emoji', body: '👍', expected: 'none' },
  {
    id: 'pet-executor-awaits-independent-review', authorIdentity: identity('pet:executor'),
    channelPrompt: collaborationPrompt,
    history: [message('human:barry', '修复空列表导出报错，交付 PR 后需要独立审查。只允许本地验证，不要合并或部署。')],
    body: '空列表导出修复已交付 PR #410，head abc1234，自测通过。尚无独立审查，请检查这次改动是否覆盖空列表场景及原有导出行为；当前仍为 Draft，未合并、未部署。',
    expected: 'pet:reviewer',
  },
  {
    id: 'pet-reviewer-needs-issue-status-alignment', authorIdentity: identity('pet:reviewer'),
    channelPrompt: collaborationPrompt,
    history: [
      message('pet:issuer', 'Issue #120 的进度记录仍是“等待独立审查”。本轮审查结束后，需要把新的结论及未合并状态整理给人类；关闭 Issue 另待确认。'),
      message('pet:executor', 'PR #410 head abc1234 已交付，自测通过，等待独立审查。'),
    ],
    body: 'PR #410 的 abc1234 已独立审查通过，空列表与原有导出行为均符合要求，未发现需修复项。Issue #120 的进度仍停在等待审查，需要对齐这条新结论；PR 仍是 Draft、未合并，不能据此关闭 Issue。',
    expected: 'pet:issuer',
  },
  {
    id: 'pet-executor-identifies-stale-wiki', authorIdentity: identity('pet:executor'),
    channelPrompt: collaborationPrompt,
    history: [
      message('human:barry', 'CSV 导出说明需要与已合并实现一致；只更新相关 Wiki 使用说明，不做功能扩展。'),
      message('pet:wiki', '当前 Wiki 的导出页仍记载“空列表会报错”，等实现交付后核对更新。'),
    ],
    body: '空列表导出修复已合入 main 的 abc1234，现在返回含表头的空 CSV；Wiki 导出页仍是旧行为，需要结合该提交核对更新。这只是仓库行为，生产部署状态未知。',
    expected: 'pet:wiki',
  },
  {
    id: 'pet-issuer-already-aligned-confirmation', authorIdentity: identity('pet:issuer'),
    channelPrompt: collaborationPrompt,
    history: [
      message('pet:reviewer', 'PR #410 abc1234 审查通过，无需修复。进度记录应区分已审查与未合并。'),
      message('pet:issuer', '进度已对齐为“已审查、未合并”，已向人类说明。下一步是否合并由人类决定，当前没有需要其他成员处理的事项。'),
    ],
    body: '确认，记录与公开结论已一致，仍等待人类的合并决定；没有新的工作或问题。',
    expected: 'none',
  },
  {
    id: 'pet-reviewer-optional-suggestion-after-closure', authorIdentity: identity('pet:reviewer'),
    channelPrompt: collaborationPrompt,
    history: [
      message('pet:reviewer', 'PR #410 已审查通过。说明文字可再精简，但不影响正确性，是可选建议。'),
      message('human:barry', '这轮不采纳措辞建议，不再修改。当前工作已收口。'),
      message('pet:issuer', '已记录审查通过，措辞建议本轮不做，没有剩余执行任务。'),
    ],
    body: '收到，措辞建议保持可选且本轮不采纳，已有通过结论不变。',
    expected: 'none',
  },
  {
    id: 'pet-wiki-completed-no-further-action', authorIdentity: identity('pet:wiki'),
    channelPrompt: collaborationPrompt,
    history: [
      message('human:barry', '最后只需同步 Wiki 导出页的空列表行为，保留生产部署未知，更新后公开结果即可结束。'),
      message('pet:issuer', '代码与审查进度已经对齐，剩余只有 Wiki 这项更新，不需要再次汇总或复审。'),
    ],
    body: 'Wiki 导出页已依据 main 的 abc1234 更新为空 CSV 含表头，并保留生产部署未知。来源和状态已标明，本轮完成，无未解决问题。',
    expected: 'none',
  },
  {
    id: 'runtime-busy-issuer-needs-review-correction', authorIdentity: identity('pet:reviewer'),
    channelPrompt: collaborationPrompt,
    history: [
      message('pet:issuer', '正在为人类汇总 Issue #120 的最新进度，目前手头记录仍是 PR #410 待审查。'),
      message('pet:executor', 'PR #410 abc1234 已完成修复和自测，等待独立结论，不需要重复开发。'),
    ],
    body: '新的独立审查结论已确认：PR #410 abc1234 通过，未发现需修复项。正在形成的 Issue #120 摘要不能继续写“待审查”，请负责进度的成员采纳这条更正；PR 仍未合并。',
    petRuntime: {
      'pet:issuer': runtime({ sessionState: 'running', admissionState: 'busy', activeScope: 'current-channel', queuedInSession: 1 }),
      'pet:executor': runtime(), 'pet:wiki': runtime(),
    },
    expected: 'pet:issuer',
  },
  {
    id: 'runtime-other-channel-busy-preserves-review-role', authorIdentity: identity('pet:executor'),
    channelPrompt: collaborationPrompt,
    history: [message('human:barry', '导出修复需要独立代码审查，其他角色不替代 Reviewer 作出审查结论。')],
    body: 'PR #410 abc1234 已交付，自测通过；请独立审查空列表与正常导出行为，尚无审查结论。没有新开发任务，也不需要更新 Wiki 或整理 Issue 台账。',
    petRuntime: {
      'pet:reviewer': runtime({ admissionState: 'busy', activeScope: 'other-channel' }),
      'pet:issuer': runtime(), 'pet:wiki': runtime(),
    },
    expected: 'pet:reviewer',
  },
  {
    id: 'runtime-waiting-human-review-is-not-handoff', authorIdentity: identity('pet:issuer'),
    channelPrompt: collaborationPrompt,
    history: [
      message('pet:reviewer', '本轮仓库内审查已完成；生产只读核对需要人类批准，审批尚未决定。'),
      message('human:barry', '生产核对先暂停，由我决定是否批准，其他成员不要代批或接手这项核对。'),
    ],
    body: '状态已记录：仓库内审查完成，生产核对等待人类决定。没有新增证据或任务，其他成员无需接手；人类尚未给出批准。',
    petRuntime: {
      'pet:reviewer': runtime({ sessionState: 'waiting', admissionState: 'waiting', activeScope: 'current-channel', waitingKind: 'human_review' }),
      'pet:executor': runtime(), 'pet:wiki': runtime(),
    },
    expected: 'none',
  },
  {
    // This request explicitly conditions dispatch on confirmed availability;
    // unknown is not a general prohibition on routing useful work.
    id: 'runtime-unknown-does-not-establish-idle', authorIdentity: identity('human:barry'),
    channelPrompt: collaborationPrompt,
    history: [],
    body: '有一份非紧急的交付说明想请 Reviewer 核对。这次仅在能确认 Reviewer 当前空闲时才派发；如果状态无法确认，先不派发，也不需要其他角色接手或回复，我稍后再安排。',
    petRuntime: {
      'pet:reviewer': runtime({ sessionState: 'unknown', admissionState: 'unknown', activeScope: 'unknown', queuedInSession: null }),
      'pet:issuer': runtime(), 'pet:executor': runtime(), 'pet:wiki': runtime(),
    },
    expected: 'none',
  },
];

function inputFor(item: Case): RouteInput {
  const channelId = `routing-eval:${item.id}`;
  const toRow = (entry: FixtureMessage, sequence: number): ChannelMessageRow => {
    const member = members.find(candidate => candidate.participantId === entry.authorIdentity.participantId);
    if (!member || member.kind !== entry.authorIdentity.kind) throw new Error(`Invalid fixture author in ${item.id}`);
    return {
      sequence, messageId: `${channelId}:${sequence}`, channelId,
      author: { kind: member.kind, id: member.id }, occurredAt: '2026-01-01T00:00:00.000Z',
      body: entry.body, mentions: [],
    };
  };
  const recent = (item.history ?? history).map((entry, index) => toRow(entry, index + 1));
  const original = item.replyTo && recent.find(row => row.body === item.replyTo!.body
    && `${row.author.kind}:${row.author.id}` === item.replyTo!.authorIdentity.participantId);
  if (item.replyTo && !original) throw new Error(`Reply target missing from history in ${item.id}`);
  const current = toRow({ body: item.body, authorIdentity: item.authorIdentity ?? identity('human:barry') }, recent.length + 1);
  if (original) current.replyTo = original.messageId;
  const input = routeInput({
    channelId, title: 'pinpawo-agent', description: '日常开发协作',
    ...(item.channelPrompt !== undefined ? { prompt: item.channelPrompt } : {}),
    createdBy: { kind: 'human', id: 'barry' }, createdAt: '', updatedAt: '',
  }, current, original, recent, members);
  // Synthetic Host observations are attached only after the production adapter
  // has established message identity and excluded the Pet author from candidates.
  for (const participantId of Object.keys(item.petRuntime ?? {})) {
    if (!input.pets.some(pet => pet.participantId === participantId)) {
      throw new Error(`Runtime fixture is not an eligible candidate in ${item.id}: ${participantId}`);
    }
  }
  return {
    ...input,
    pets: input.pets.map(pet => {
      const sampled = item.petRuntime?.[pet.participantId as PetParticipantId];
      return sampled ? { ...pet, runtime: sampled } : pet;
    }),
  };
}

const requestedIds = process.env.ROUTING_EVAL_CASE_IDS?.split(',').map(id => id.trim()).filter(Boolean);
const unknownIds = requestedIds?.filter(id => !cases.some(item => item.id === id)) ?? [];
if (unknownIds.length) throw new Error(`Unknown ROUTING_EVAL_CASE_IDS: ${unknownIds.join(', ')}`);
if (requestedIds && !requestedIds.length) throw new Error('ROUTING_EVAL_CASE_IDS must select at least one case.');
const selectedCases = requestedIds ? cases.filter(item => requestedIds.includes(item.id)) : cases;
// Construct every selected input before loading credentials or making model calls.
const inputs = new Map(selectedCases.map(item => [item.id, inputFor(item)]));
if (process.env.ROUTING_EVAL_LIST_CASES === '1') {
  console.log(JSON.stringify(selectedCases.map(item => ({ id: item.id, authorIdentity: inputs.get(item.id)!.message.authorIdentity, expected: item.expected })), null, 2));
  process.exit(0);
}

const profileId = process.env.ROUTING_EVAL_MODEL_PROFILE_ID ?? process.env.PROMPT_EVAL_MODEL_PROFILE_ID;
if (!profileId) throw new Error('Set ROUTING_EVAL_MODEL_PROFILE_ID to a model profile from ~/.pinpawo/config.json.');
const repeats = Number(process.env.ROUTING_EVAL_REPEATS ?? 3);
const threshold = process.env.ROUTING_EVAL_THRESHOLD ? Number(process.env.ROUTING_EVAL_THRESHOLD) : undefined;
if (!Number.isSafeInteger(repeats) || repeats < 1) throw new Error('ROUTING_EVAL_REPEATS must be a positive integer.');
if (threshold !== undefined && (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)) {
  throw new Error('ROUTING_EVAL_THRESHOLD must be between 0 and 1.');
}
const outputDirectory = process.env.ROUTING_EVAL_OUTPUT_DIR ? resolve(process.env.ROUTING_EVAL_OUTPUT_DIR) : undefined;
if (outputDirectory) {
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  chmodSync(outputDirectory, 0o700);
  if (['rows.jsonl', 'report.json'].some(name => existsSync(resolve(outputDirectory, name)))) {
    throw new Error('ROUTING_EVAL_OUTPUT_DIR already contains results; choose a new directory.');
  }
}
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

type Row = {
  id: string; repeat: number; expected: string; got: string; passed: boolean;
  ms: number; detail: string; focus: string | null; error: boolean;
  input: RouteInput; outcome: RouteOutcome;
};
const rows: Row[] = [];
const rowsFile = outputDirectory ? openSync(resolve(outputDirectory, 'rows.jsonl'), 'wx', 0o600) : undefined;
try {
  for (const item of selectedCases) {
    for (let run = 0; run < repeats; run++) {
      const input = inputs.get(item.id)!;
      const started = performance.now();
      const outcome = await router.decide(input);
      const ms = Math.round(performance.now() - started);
      const got = outcome.kind === 'route' ? outcome.participantId : 'none';
      const detail = outcome.kind === 'route'
        ? `${outcome.confidence} ${outcome.reason ?? ''}`
        : `${outcome.reason} ${outcome.confidence ?? ''} ${outcome.detail ?? ''}`;
      const error = outcome.kind === 'skip' && (outcome.reason === 'error' || outcome.reason === 'invalid');
      const focus = outcome.kind === 'route' ? outcome.focus ?? null : null;
      const row: Row = { id: item.id, repeat: run + 1, expected: item.expected, got,
        passed: got === item.expected && !error, ms, detail: detail.trim(), focus, error, input, outcome };
      rows.push(row);
      if (rowsFile !== undefined) writeFileSync(rowsFile, `${JSON.stringify(row)}\n`);
      console.log(`${row.passed ? 'PASS' : 'FAIL'} ${item.id}#${run + 1} expected=${item.expected} got=${got} ${ms}ms ${detail.trim()} focus=${JSON.stringify(focus)}`);
    }
  }
} finally {
  if (rowsFile !== undefined) closeSync(rowsFile);
}

const passed = rows.filter(row => row.passed).length;
const falseWakes = rows.filter(row => row.expected === 'none' && row.got !== 'none').length;
const misses = rows.filter(row => row.expected !== 'none' && row.got === 'none').length;
const wrongPet = rows.filter(row => row.expected !== 'none' && row.got !== 'none' && row.got !== row.expected).length;
const errors = rows.filter(row => row.error).length;
const routed = rows.filter(row => row.outcome.kind === 'route');
const withFocus = routed.filter(row => row.focus !== null).length;
const latencies = rows.map(row => row.ms).sort((a, b) => a - b);
const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))];
const summary = {
  profileId, model: profile.model, repeats, cases: selectedCases.length, threshold: threshold ?? 0.5,
  caseIds: selectedCases.map(item => item.id),
  passed: `${passed}/${rows.length}`, falseWakes, misses, wrongPet, errors,
  // Optional focus is observed, not graded by matching prompt prose.
  focus: { routed: routed.length, present: withFocus, presenceRate: routed.length ? withFocus / routed.length : null },
  latencyMs: { p50: pct(0.5), p95: pct(0.95) },
};
console.log(JSON.stringify(summary, null, 2));
if (outputDirectory) {
  writeFileSync(resolve(outputDirectory, 'report.json'), `${JSON.stringify({
    scope: 'Real-model routing decisions over synthetic stored Channel messages and optional synthetic runtime observations; no live runtime sampling, Pet execution, Channel delivery, or domain actions are exercised. Focus presence is observational, not a quality judgment.',
    routingNotes: notes, summary, rows,
  }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}
if (passed !== rows.length) process.exitCode = 1;
