import { createHash } from 'node:crypto';
import type { HeadInput, HeadMessage } from '../../../../packages/studio/src/host/petHead';
export const fixtureVersion = 'head-relevance-idle-v1';
export type Route = 'silent' | 'reply-only' | 'dispatch-only' | 'combined';
export type EvalCase = { id: string; kind: 'contrast' | 'organic'; input: HeadInput; routes: Route[]; relevance: boolean[]; state: 'idle' | 'busy' | 'unknown' };
const message = (id: string, body: string, kind: 'human' | 'pet' = 'human'): HeadMessage => ({
  messageId: id, channelId: 'synthetic-eval', sequence: 2, author: { kind, id: kind === 'human' ? 'owner' : 'peer' },
  occurredAt: '2026-01-01T00:00:00Z', body, mentions: [],
});
const base = (id: string, body: string, kind: 'human' | 'pet' = 'human'): HeadInput => ({
  pet: { petId: 'analyst', definitionId: 'analyst', name: '数据分析员', channelId: 'synthetic-eval', createdAt: '2026-01-01T00:00:00Z' },
  description: '负责数据核对和解释；不替其他成员表态。', message: message(id, body, kind), context: { messages: [] },
});
const active = { ...message('active-source', '核对季度报告中的收入口径，完成后给出差异表。'), sequence: 1 };
function queued(id: string, body: string, author: 'human' | 'pet'): HeadInput {
  return { ...base(id, body, author), context: { messages: [active] } };
}
const fixtures: Array<{ id: string; kind: EvalCase['kind']; input: HeadInput; routes: Route[] }> = [
  { id: 'ignore-unrelated', kind: 'contrast', input: base('ignore-unrelated', '给设计师：封面颜色由你定，数据分析员不用回复。'), routes: ['silent'] },
  { id: 'reply-only', kind: 'contrast', input: base('reply-only', '数据分析员，只确认你是否负责数据核对，用一句话回复，不启动任何工作。'), routes: ['reply-only'] },
  { id: 'dispatch-only', kind: 'contrast', input: base('dispatch-only', '数据分析员，开始核对本季度两份报表的差异。不要先确认或发进度消息，完成后再汇报。'), routes: ['dispatch-only'] },
  { id: 'combined', kind: 'contrast', input: base('combined', '数据分析员，请先简短确认收到，然后核对两份季度报表，找出差异并给出结果。'), routes: ['combined'] },
  ...(['human', 'pet'] as const).flatMap(author => {
    const participantId = 'pet:analyst';
    const mention = '[@数据分析员](participant:pet:analyst)';
    const evidence = { ...message('published-evidence', '合成证据：仓单 A 和仓单 B 使用同一盘点日；A 的调拨在途项未计入期末库存。', 'pet'), sequence: 1 };
    const packet = '盘点核对方案已经整理完：先核对盘点日期，再核对期末库存。计划按“记录齐全、可排期”交付。';
    return [
      { name: 'review', body: `${packet}\n\n${mention} 请独立核查上面的方案和频道里的证据，把遗漏项或证据不支持的结论列出来。`,
        routes: ['dispatch-only', 'combined'] as Route[] },
      { name: 'review-status', body: `${packet}\n\n${mention} 你对上面这个方案的核查现在做到哪一步了？只告诉我当前状态，不要重新核查。`,
        routes: ['reply-only'] as Route[] },
      { name: 'thanks', body: `${mention} 辛苦了，谢谢。`, routes: ['silent'] as Route[] },
    ].map(({ name, body, routes, ...expectations }) => {
      const id = `addressed-${name}-${author}`;
      const input = base(id, body, author);
      const source = {
        ...input.message, mentions: [{ participantId }], author: { kind: author, id: author === 'pet' ? 'executor' : 'owner' },
        ...(author === 'pet' ? { externalRef: `synthetic-final:${id}` } : {}),
      };
      return {
        id, kind: 'contrast' as const, input: {
          ...input, description: '负责独立复核方案及其依据，列明证据缺口；不负责改写或实施方案。',
          addressed: true, message: source,
          context: { messages: [evidence], members: [{ kind: 'pet' as const, id: input.pet.petId, participantId }] },
        }, routes, ...expectations,
      };
    });
  }),
  { id: 'no-at-followup', kind: 'contrast', input: { ...base('no-at-followup', '请继续你刚才的核对，把差异按月份归类。'), message: { ...message('no-at-followup', '请继续你刚才的核对，把差异按月份归类。'), replyTo: 'prior-answer' }, context: { messages: [{ ...message('prior-answer', '我已核对总额，下一步可以逐月归类。', 'pet'), author: { kind: 'pet', id: 'analyst' }, sequence: 1 }] } }, routes: ['dispatch-only', 'combined'] },
  { id: 'progress-only', kind: 'contrast', input: queued('progress-only', '当前收入核对进行到哪了？', 'human'), routes: ['reply-only'] },
  { id: 'conditional-work', kind: 'contrast', input: queued('conditional-work', '只有当前收入核对还没完成，你才去整理下周指标清单；不需要回复。', 'human'), routes: ['silent'] },
  { id: 'conditional-and-independent-work', kind: 'contrast', input: queued('conditional-and-independent-work', '只有当前收入核对还没完成，才去整理下周指标清单。另外，不论核对结果如何，请独立对比四月的两张报表。', 'human'), routes: ['reply-only'] },
  { id: 'progress-and-addition', kind: 'contrast', input: queued('progress-and-addition', '当前收入核对进行到哪了？另外帮我整理下周的指标清单。', 'human'), routes: ['reply-only'] },
  { id: 'busy-independent-work', kind: 'contrast', input: queued('busy-independent-work', '请另外独立整理下周的指标清单。', 'human'), routes: ['reply-only'] },
  ...(['human', 'pet'] as const).flatMap(author => [
    { id: `queue-${author}`, kind: 'contrast' as const, input: queued(`queue-${author}`, '当前核对完成后，再整理下周的指标清单，不要打断当前工作。', author), routes: ['silent', 'reply-only'] as Route[] },
    { id: `unsupported-edit-${author}`, kind: 'contrast' as const, input: queued(`unsupported-edit-${author}`, '刚确认当前报告所用源表版本错误，请立即停止基于旧表的核对，先确认正确版本再继续，旧结论不能发布。', author), routes: ['silent', 'reply-only'] as Route[] },
  ]),
  { id: 'peer-ack-not-new-request', kind: 'contrast', input: {
    ...base('peer-ack-not-new-request', '我理解要分析的是两份季度报表的差异，我会核对后给出结果。', 'pet'),
    message: { ...message('peer-ack-not-new-request', '我理解要分析的是两份季度报表的差异，我会核对后给出结果。', 'pet'), replyTo: 'original-human-request' },
    context: { messages: [{ ...message('original-human-request', '请各位先简短确认收到，然后分别核对两份季度报表，找出差异并给出结果。'), sequence: 1 }] },
  }, routes: ['silent'] },
  { id: 'peer-neutral-noop', kind: 'contrast', input: base('peer-neutral-noop', '我已收到，暂无新信息，不需要其他成员回复。', 'pet'), routes: ['silent'] },
  { id: 'peer-direct-ask', kind: 'contrast', input: base('peer-direct-ask', '数据分析员，请用一句话解释同比和环比有什么区别。我正在写说明，只需直接解释，不需启动新任务。', 'pet'), routes: ['reply-only'] },
  { id: 'organic-peer', kind: 'organic', input: base('organic-peer', '我怀疑月份边界会影响收入统计，但还没看到证据。', 'pet'), routes: ['silent', 'reply-only', 'dispatch-only', 'combined'] },
];

// Case labels and expectations never enter the model prompt. Stable opaque IDs
// preserve references without providing the expected route in a message ID.
const opaque = (value: string) => 'm-' + createHash('sha256').update(value).digest('hex').slice(0, 16);
const remap = (item: HeadMessage): HeadMessage => ({ ...item, messageId: opaque(item.messageId),
  ...(item.replyTo ? { replyTo: opaque(item.replyTo) } : {}),
  ...(item.externalRef ? { externalRef: opaque(item.externalRef) } : {}) });
export const cases: EvalCase[] = fixtures.map(test => {
  const busy = /^(busy-|queue-|unsupported-edit-|progress-|conditional-)/.test(test.id);
  return { id: test.id, kind: test.kind as EvalCase['kind'],
    state: busy ? 'busy' : 'idle',
    relevance: test.id === 'organic-peer' ? [true, false]
      : [!['ignore-unrelated', 'peer-ack-not-new-request', 'peer-neutral-noop'].includes(test.id)],
    routes: test.routes,
    input: { ...test.input, message: remap(test.input.message),
      context: { ...test.input.context, messages: test.input.context.messages.map(remap) } },
  };
});
for (const state of ['idle', 'busy', 'unknown'] as const) {
  const input = base('mention-' + state, '[@数据分析员](participant:pet:analyst)');
  input.message.mentions = [{ participantId: 'pet:analyst' }];
  input.context.members = [{ kind: 'pet', id: 'analyst', participantId: 'pet:analyst' }];
  cases.push({ id: 'bare-mention-' + state, kind: 'contrast', state, relevance: [true], routes: ['silent'],
    input: { ...input, message: remap(input.message) } });
}
