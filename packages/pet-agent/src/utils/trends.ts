import type { DailyPostPayload, RecentDailyPost, TrendPromptItem } from '../types/domain';
import { jaccardSimilarity, normalizeText } from './text';

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function isLikelyVideoTrend(
  trend: Pick<TrendPromptItem, 'title' | 'summary' | 'url' | 'raw'>,
): boolean {
  const raw = trend.raw && typeof trend.raw === 'object'
    ? (trend.raw as Record<string, unknown>)
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
  const candidateTopic = normalizeText(payload.topic ?? '');

  for (const item of recent) {
    const topic = normalizeText(item.topic ?? '');
    if (candidateTopic && topic && candidateTopic === topic) {
      return true;
    }
    if (jaccardSimilarity(payload.content, item.content) >= 0.82) {
      return true;
    }
  }

  return false;
}
