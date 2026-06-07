import type { DailyPostPayload, RecentDailyPost, TrendPromptItem } from './types';

function normalizeForDuplicate(input: string | null | undefined): string {
  return (input ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function jaccardSimilarity(a: string, b: string): number {
  const left = new Set(normalizeForDuplicate(a).split('').filter(Boolean));
  const right = new Set(normalizeForDuplicate(b).split('').filter(Boolean));
  if (left.size === 0 && right.size === 0) return 1;
  const intersection = [...left].filter((char) => right.has(char)).length;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i.test(value);
}

function isLikelyVideoTrend(
  trend: Pick<TrendPromptItem, 'title' | 'summary' | 'url' | 'raw'>,
): boolean {
  const raw = trend.raw && typeof trend.raw === 'object'
    ? trend.raw
    : {};

  const directSignals = [
    raw.is_video === true,
    raw.media_type === 'video',
    raw.note_type === 'video',
    raw.content_type === 'video',
    raw.item_type === 'video',
    raw.post_type === 'video',
    typeof raw.video_url === 'string',
    typeof raw.play_url === 'string',
    typeof raw.play_addr === 'string',
    Array.isArray(raw.video_urls) && raw.video_urls.length > 0,
    raw.aweme_type === 4,
  ];

  if (directSignals.some(Boolean)) {
    return true;
  }

  const text = [trend.title, trend.summary, trend.url]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
    .toLowerCase();

  return /\bvideo\b/.test(text) || /视频|录像|短片|片段/.test(text);
}

export function isSemanticDuplicate(payload: DailyPostPayload, recent: RecentDailyPost[]): boolean {
  const candidateTopic = normalizeForDuplicate(payload.topic ?? '');

  for (const item of recent) {
    const topic = normalizeForDuplicate(item.topic ?? '');
    if (candidateTopic && topic && candidateTopic === topic) {
      return true;
    }
    if (jaccardSimilarity(payload.content, item.content) >= 0.82) {
      return true;
    }
  }

  return false;
}

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
