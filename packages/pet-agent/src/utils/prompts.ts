import type { AgentActor } from '../types/agent';
import type { TrendPromptItem } from '../types/domain';
import { isLikelyVideoTrend } from './trends';

export function formatTrendPromptItems(rows: TrendPromptItem[]): string {
  if (rows.length === 0) return '';

  return rows
    .map((row, index) => {
      const topic = row.topic ? `#${row.topic}` : '#general';
      const summary = row.summary ?? '无摘要';
      const indicators = [
        isLikelyVideoTrend(row) ? '[视频]' : null,
        Array.isArray(row.imageUrls) && row.imageUrls.length > 0 ? '[有图]' : null,
      ].filter(Boolean).join(' ');
      return `${index + 1}. [${row.id}] (${row.platform}) ${topic} ${row.title}\n   摘要：${summary}  热度分：${row.score}${indicators ? `  ${indicators}` : ''}`;
    })
    .join('\n');
}

export function buildObservePrompts(input: {
  actor: AgentActor;
  recentDailyText?: string;
  avoidTopics?: string[];
  objective: string;
  trendText: string;
  maxObserveItems: number;
}): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = [
    `你是「${input.actor.name}」的内容选择器。`,
    '你正在为当前对话目标，从一批小红书内容里挑出最值得继续处理的一条。',
    `这轮最多只看 ${input.maxObserveItems} 条候选，宁缺毋滥。`,
    '判断标准：结合当前目标，哪一条最值得继续创作、讨论或转发。',
    '如果没有任何一条明显足够强，就返回不选。',
    '只返回一个 json 结构化选择结果，不要输出其他内容。',
  ].join('\n');

  const userPrompt = [
    `[当前目标]\n${input.objective}`,
    input.recentDailyText ? `[近期动态]\n${input.recentDailyText}` : null,
    input.avoidTopics?.length ? `[避免重复的主题]\n${input.avoidTopics.join('、')}` : null,
    input.trendText ? `[候选内容]\n${input.trendText}` : '[候选内容]\n（无）',
    '请返回一个 json 对象，字段使用 snake_case。',
    '优先只使用这两个字段：selected_id 和 reason。不要发明别的字段名。',
  ].filter(Boolean).join('\n\n');

  return { systemPrompt, userPrompt };
}

export function buildDailyImagePromptPrompts(input: {
  actor: AgentActor;
  content: string;
  mood?: string | null;
  topic?: string | null;
  selectedTrend?: TrendPromptItem | null;
}): { systemPrompt: string; userPrompt: string } {
  const trendHint = input.selectedTrend
    ? `触发这条动态的热点：${input.selectedTrend.title}\n摘要：${input.selectedTrend.summary ?? '无'}`
    : '这条动态来自宠物自己的即时感受。';

  const systemPrompt = [
    `你是「${input.actor.name}」的图片规划器。`,
    '只做一件事：为已经写好的原创动态生成图片计划。',
    '以 json 格式输出，包含字段：prompt、negativePrompt、style、shot、seed。',
    'prompt 必须以”让图片中的角色”开头，只描述单帧可拍下来的具体画面，不要写抽象比喻，不要改角色设定。',
  ].join('\n');

  const userPrompt = [
    `[动态正文]\n${input.content}`,
    input.topic ? `[主题]\n${input.topic}` : null,
    input.mood ? `[情绪]\n${input.mood}` : null,
    `[触发背景]\n${trendHint}`,
  ].filter(Boolean).join('\n\n');

  return { systemPrompt, userPrompt };
}
