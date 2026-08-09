import {
  PROVIDER_INPUT_WATERMARK_RATIO,
  type BuiltinGlobalReviewPolicyMode,
} from '@pinpawo/pet-agent';
import stringWidth from 'string-width';
import { formatGlobalReviewPolicyMode } from './globalReviewPolicyPicker';
import { truncateLine } from './render/terminalText';
import type { SessionModel } from './state/tuiState';

const LOCALE_FORMATTER = new Intl.NumberFormat('zh-CN');
const STATUS_SEPARATOR = ' · ';

export type StatusSegmentTone = 'muted' | 'info' | 'success' | 'warning' | 'danger';
export type StatusSegmentTruncation = 'preserve' | 'truncate';

export type StatusSegment = {
  id: string;
  label?: string;
  value: string;
  compactValue?: string;
  priority: number;
  tone?: StatusSegmentTone;
  truncation: StatusSegmentTruncation;
};

export type StatusBarLine = {
  id: 'primary' | 'session';
  muted: boolean;
  segments: StatusSegment[];
};

export type StatusBarModel = {
  lines: StatusBarLine[];
};

export type FormattedStatusBarPart = {
  text: string;
  tone: StatusSegmentTone;
  segmentId?: string;
  separator?: boolean;
};

export type FormattedStatusBarLine = {
  id: StatusBarLine['id'];
  muted: boolean;
  parts: FormattedStatusBarPart[];
};

export function buildStatusBarModel(input: {
  activityStatus?: string | null;
  statusNotice?: string | null;
  connectionStatus: string;
  session: SessionModel | null;
  globalReviewPolicyMode: BuiltinGlobalReviewPolicyMode;
  overlayOwner?: string | null;
}): StatusBarModel {
  const runtime = input.session?.runtime;
  const hasPrimaryStatus = Boolean(input.activityStatus || input.statusNotice);
  return {
    lines: [
      {
        id: 'primary',
        muted: false,
        segments: [
          ...(input.activityStatus ? [{
            id: 'activity',
            value: input.activityStatus,
            priority: 100,
            tone: statusTone(input.activityStatus),
            truncation: 'truncate' as const,
          }] : []),
          ...(input.statusNotice ? [{
            id: 'notice',
            value: input.statusNotice,
            priority: 99,
            tone: statusTone(input.statusNotice),
            truncation: 'truncate' as const,
          }] : []),
          {
            id: 'connection',
            ...(hasPrimaryStatus ? { label: '连接' } : {}),
            value: input.connectionStatus,
            priority: hasPrimaryStatus ? 95 : 100,
            tone: statusTone(input.connectionStatus),
            truncation: 'truncate',
          },
          ...(input.overlayOwner ? [{
            id: 'overlay',
            label: '浮层',
            value: input.overlayOwner,
            priority: 85,
            tone: 'info' as const,
            truncation: 'preserve' as const,
          }] : []),
          {
            id: 'policy',
            label: '授权',
            value: formatGlobalReviewPolicyMode(input.globalReviewPolicyMode),
            priority: 80,
            tone: 'muted',
            truncation: 'preserve',
          },
        ],
      },
      {
        id: 'session',
        muted: true,
        segments: [
          {
            id: 'tokens',
            label: 'Token',
            value: formatTokenUsage(input.session),
            compactValue: formatCompactTokenUsage(input.session),
            priority: 100,
            tone: 'muted',
            truncation: 'truncate',
          },
          {
            id: 'model',
            label: '模型',
            value: fallback(runtime?.model),
            priority: 90,
            tone: 'muted',
            truncation: 'preserve',
          },
          {
            id: 'cwd',
            label: '目录',
            value: fallback(runtime?.cwd),
            priority: 70,
            tone: 'muted',
            truncation: 'preserve',
          },
        ],
      },
    ],
  };
}

export function formatStatusBarText(model: StatusBarModel, width: number) {
  return formatStatusBarLines(model, width)
    .map((line) => line.parts.map((part) => part.text).join(''))
    .join('\n');
}

export function formatStatusBarLines(model: StatusBarModel, width: number): FormattedStatusBarLine[] {
  return model.lines.map((line) => ({
    id: line.id,
    muted: line.muted,
    parts: formatStatusLineParts(line.segments, width),
  }));
}

function formatStatusLineParts(segments: StatusSegment[], width: number): FormattedStatusBarPart[] {
  const maxWidth = Math.max(0, width);
  if (maxWidth === 0) return [];

  const orderedSegments = segments
    .map((segment, order) => ({
      segment: width < 56 && segment.compactValue
        ? { ...segment, value: segment.compactValue }
        : segment,
      order,
    }))
    .filter(({ segment }) => Boolean(segment.value.trim()));
  if (orderedSegments.length === 0) return [];

  const selected = new Set<string>();
  for (const candidate of [...orderedSegments].sort((a, b) =>
    b.segment.priority - a.segment.priority || a.order - b.order)) {
    selected.add(candidate.segment.id);
    const rendered = renderSegments(orderedSegments, selected);
    if (measureFits(rendered, maxWidth)) continue;
    if (selected.size === 1) continue;
    if (
      candidate.segment.truncation === 'truncate'
      && segmentContributesWhenTruncated(orderedSegments, selected, candidate.segment.id, maxWidth)
    ) {
      continue;
    }
    selected.delete(candidate.segment.id);
  }

  const parts = buildStatusBarParts(orderedSegments, selected);
  if (parts.length > 0) return truncateStatusBarParts(parts, maxWidth);

  return truncateStatusBarParts([partForSegment(orderedSegments[0].segment)], maxWidth);
}

function renderSegments(
  orderedSegments: Array<{ segment: StatusSegment; order: number }>,
  selected: Set<string>,
) {
  return orderedSegments
    .filter(({ segment }) => selected.has(segment.id))
    .map(({ segment }) => formatSegment(segment))
    .join(STATUS_SEPARATOR);
}

function buildStatusBarParts(
  orderedSegments: Array<{ segment: StatusSegment; order: number }>,
  selected: Set<string>,
) {
  const parts: FormattedStatusBarPart[] = [];
  for (const { segment } of orderedSegments) {
    if (!selected.has(segment.id)) continue;
    if (parts.length > 0) {
      parts.push({
        text: STATUS_SEPARATOR,
        tone: 'muted',
        separator: true,
      });
    }
    parts.push(partForSegment(segment));
  }
  return parts;
}

function segmentContributesWhenTruncated(
  orderedSegments: Array<{ segment: StatusSegment; order: number }>,
  selected: Set<string>,
  segmentId: string,
  width: number,
) {
  return truncateStatusBarParts(buildStatusBarParts(orderedSegments, selected), width)
    .some((part) => part.segmentId === segmentId);
}

function partForSegment(segment: StatusSegment): FormattedStatusBarPart {
  return {
    text: formatSegment(segment),
    tone: segment.tone ?? 'muted',
    segmentId: segment.id,
  };
}

function truncateStatusBarParts(
  parts: FormattedStatusBarPart[],
  width: number,
): FormattedStatusBarPart[] {
  const text = parts.map((part) => part.text).join('');
  if (truncateLine(text, width) === text) return parts;
  if (width <= 0) return [];
  if (width <= 1) {
    return [{ text: '…', tone: firstSegmentTone(parts) }];
  }

  const targetWidth = width - 1;
  const clipped: FormattedStatusBarPart[] = [];
  let currentWidth = 0;
  for (const part of parts) {
    let textPart = '';
    for (const char of Array.from(part.text)) {
      const charWidth = Math.max(1, stringWidth(char));
      if (currentWidth + charWidth > targetWidth) break;
      textPart += char;
      currentWidth += charWidth;
    }
    if (textPart) {
      clipped.push({ ...part, text: textPart });
    }
    if (currentWidth >= targetWidth) break;
  }

  trimStatusPartSuffix(clipped);
  const lastPart = clipped.at(-1);
  if (!lastPart) {
    return [{ text: '…', tone: firstSegmentTone(parts) }];
  }
  lastPart.text = `${lastPart.text}…`;
  return clipped;
}

function trimStatusPartSuffix(parts: FormattedStatusBarPart[]) {
  while (parts.length > 0) {
    const lastPart = parts[parts.length - 1];
    if (!lastPart) return;
    const trimmed = lastPart.text.trimEnd().replace(/[ ·:：-]+$/, '');
    if (trimmed === lastPart.text) return;
    if (trimmed) {
      lastPart.text = trimmed;
      continue;
    }
    parts.pop();
  }
}

function firstSegmentTone(parts: FormattedStatusBarPart[]) {
  return parts.find((part) => !part.separator)?.tone ?? 'muted';
}

function measureFits(text: string, width: number) {
  return truncateLine(text, width) === text;
}

function formatSegment(segment: StatusSegment) {
  return segment.label ? `${segment.label}:${segment.value}` : segment.value;
}

function statusTone(status: string): StatusSegmentTone {
  if (/打断|等待|处理中|调用|思考|回复|初始化中|连接本地服务|后重试|后重连/.test(status)) {
    return 'warning';
  }
  if (/错|失败|断开|不可用|无法连接|未连接/.test(status)) return 'danger';
  if (/就绪|已连接/.test(status)) return 'success';
  return 'muted';
}

function fallback(value: string | undefined) {
  const text = value?.trim();
  return text ? text : '未提供';
}

function formatTokenUsage(session: SessionModel | null) {
  const usage = session?.sessionTokenUsage;
  const contextWindow = usage?.contextWindow ?? session?.runtime.contextWindow;
  if (usage) {
    const remaining = formatCompactionRemaining(usage.latestInputTokens, contextWindow);
    return [
      `in/out ${formatCount(usage.inputTokens)}/${formatCount(usage.outputTokens)}`,
      ...(remaining ? [`compact余${remaining}`] : []),
    ].join(' · ');
  }
  if (contextWindow) {
    return `暂无 · 上限${formatCount(contextWindow)}`;
  }
  return '暂无';
}

function formatCompactTokenUsage(session: SessionModel | null) {
  const usage = session?.sessionTokenUsage;
  const contextWindow = usage?.contextWindow ?? session?.runtime.contextWindow;
  if (usage) {
    const remaining = formatCompactionRemaining(usage.latestInputTokens, contextWindow);
    return [
      `${formatCount(usage.inputTokens)}/${formatCount(usage.outputTokens)}`,
      ...(remaining ? [`C余${remaining}`] : []),
    ].join(' · ');
  }
  if (contextWindow) {
    return `暂无 · 上限${formatCount(contextWindow)}`;
  }
  return '暂无';
}

function formatCompactionRemaining(
  latestInputTokens: number | undefined,
  contextWindow: number | undefined,
) {
  if (latestInputTokens === undefined || !contextWindow) return null;
  const watermark = Math.max(1, Math.floor(contextWindow * PROVIDER_INPUT_WATERMARK_RATIO));
  return formatCount(Math.max(0, watermark - latestInputTokens));
}

function formatCount(value: number) {
  return LOCALE_FORMATTER.format(Math.max(0, Math.round(value)));
}
