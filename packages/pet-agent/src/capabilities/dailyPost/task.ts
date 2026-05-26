import type { AgentActor } from '../../types/agent';
import type { RecentDailyPost, TrendPromptItem } from '../../types/domain';
import { formatTrendPromptItems } from '../../utils/prompts';

function normalizeText(input: string | null | undefined) {
  if (!input) return '';
  return input.replace(/\s+/g, ' ').trim();
}

function formatRecentDailyPosts(items: RecentDailyPost[]): string {
  if (items.length === 0) return '';

  return items
    .map((item, index) => {
      const topic = item.topic ? `#${item.topic}` : '#untitled';
      const tags = item.tags?.length ? ` 标签：${item.tags.join('、')}` : '';
      return `${index + 1}. ${topic}\n   ${item.content}${tags}`;
    })
    .join('\n');
}

export function buildDailyPostObserveObjective(input: {
  actor: Pick<AgentActor, 'name'>;
  avoidTopics?: string[];
}): string {
  return [
    `请为「${input.actor.name}」选择今天最值得继续处理的一条内容。`,
    '目标不是泛泛挑一个热点，而是选出今天最值得继续创作、评论或转发的一条。',
    input.avoidTopics?.length ? `尽量避开这些近期已发过的主题：${input.avoidTopics.join('、')}` : null,
    '如果没有任何一条明显足够强，就返回不选。',
  ].filter(Boolean).join(' ');
}

export function buildDailyPostTaskMessage(input: {
  actor: Pick<AgentActor, 'name' | 'personality'>;
  petMemoryText?: string;
  recentDaily?: RecentDailyPost[];
  trendItems?: TrendPromptItem[];
  avoidTopics?: string[];
  today?: string;
}): string {
  const personality = normalizeText(input.actor.personality) || '温暖治愈';
  const recentDailyText = formatRecentDailyPosts(input.recentDaily ?? []);
  const trendText = formatTrendPromptItems((input.trendItems ?? []).slice(0, 5));

  return [
    input.today ? `当前日期：${input.today}` : null,
    `你是「${input.actor.name}」，性格 ${personality}。`,
    input.petMemoryText ? `[记忆]\n${input.petMemoryText}` : null,
    recentDailyText ? `[近期动态]\n${recentDailyText}` : null,
    input.avoidTopics?.length ? `[避免重复主题]\n${input.avoidTopics.join('、')}` : null,
    trendText ? `[可见候选热点]\n${trendText}` : '[可见候选热点]\n（无）',
    '今天请完成一轮动态处理任务。',
    '如果需要先判断哪条内容最值得继续处理，先激活 trend_observe 并调用 observe_trends。',
    '选中内容后，再切换到 daily_post，并通过 finalize_post 或 skip_post 完成本轮任务。',
    '如果候选里没有明显值得写的内容，也可以跳过，不要硬写。',
    '不要直接输出正文、JSON 或结论，必须通过能力工具完成。',
  ].filter(Boolean).join('\n\n');
}
