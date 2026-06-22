import type { BuiltinGlobalReviewPolicyMode } from '@pinpawo/pet-agent';
import stringWidth from 'string-width';
import { formatGlobalReviewPolicyMode } from './globalReviewPolicyPicker';
import { truncateLine } from './render/terminalText';
import type { SessionModel, TuiInteractionMode } from './state/tuiState';

const LOCALE_FORMATTER = new Intl.NumberFormat('zh-CN');
const STATUS_SEPARATOR = ' · ';
const TRUNCATE_IN_PLACE_PRIORITY = 95;

export type StatusSegmentTone = 'muted' | 'info' | 'success' | 'warning' | 'danger';
export type StatusSegmentTruncation = 'preserve' | 'truncate';

export type StatusSegment = {
  id: string;
  label?: string;
  value: string;
  priority: number;
  tone?: StatusSegmentTone;
  truncation: StatusSegmentTruncation;
};

export type StatusBarModel = {
  segments: StatusSegment[];
};

export type FormattedStatusBarPart = {
  text: string;
  tone: StatusSegmentTone;
  segmentId?: string;
  separator?: boolean;
};

export function buildStatusBarModel(input: {
  activityStatus?: string | null;
  connectionStatus: string;
  mode: TuiInteractionMode;
  session: SessionModel | null;
  globalReviewPolicyMode: BuiltinGlobalReviewPolicyMode;
  overlayOwner?: string | null;
}): StatusBarModel {
  const runtime = input.session?.runtime;
  return {
    segments: [
      ...(input.activityStatus ? [{
        id: 'activity',
        value: input.activityStatus,
        priority: 100,
        tone: statusTone(input.activityStatus),
        truncation: 'truncate' as const,
      }] : []),
      {
        id: 'connection',
        ...(input.activityStatus ? { label: '连接' } : {}),
        value: input.connectionStatus,
        priority: input.activityStatus ? 95 : 100,
        tone: statusTone(input.connectionStatus),
        truncation: 'truncate',
      },
      {
        id: 'mode',
        value: formatInteractionMode(input.mode),
        priority: 90,
        tone: input.mode === 'studio' ? 'info' : 'muted',
        truncation: 'preserve',
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
      {
        id: 'model',
        label: '模型',
        value: fallback(runtime?.model),
        priority: 50,
        tone: 'muted',
        truncation: 'truncate',
      },
      {
        id: 'context',
        label: '上下文',
        value: formatContext(input.session),
        priority: 40,
        tone: 'muted',
        truncation: 'preserve',
      },
      {
        id: 'cwd',
        label: '目录',
        value: fallback(runtime?.cwd),
        priority: 20,
        tone: 'muted',
        truncation: 'truncate',
      },
    ],
  };
}

export function formatStatusBarText(model: StatusBarModel, width: number) {
  return formatStatusBarParts(model, width).map((part) => part.text).join('');
}

export function formatStatusBarParts(model: StatusBarModel, width: number): FormattedStatusBarPart[] {
  const maxWidth = Math.max(0, width);
  if (maxWidth === 0) return [];

  const orderedSegments = model.segments
    .map((segment, order) => ({ segment, order }))
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
      && candidate.segment.priority >= TRUNCATE_IN_PLACE_PRIORITY
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

function formatInteractionMode(mode: TuiInteractionMode) {
  return mode === 'studio' ? 'Studio' : 'Chat';
}

function statusTone(status: string): StatusSegmentTone {
  if (/打断|等待|处理中|调用|思考|回复|初始化|连接本地服务|重试|重连/.test(status)) {
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

function formatContext(session: SessionModel | null) {
  const usage = session?.tokenUsage;
  const contextWindow = usage?.contextWindow ?? session?.runtime.contextWindow;
  if (usage && contextWindow) {
    return `${formatCount(usage.totalTokens)}/${formatCount(contextWindow)} (${formatRatio(usage.totalTokens, contextWindow)})`;
  }
  if (usage) {
    return `${formatCount(usage.totalTokens)} tokens`;
  }
  if (contextWindow) {
    return formatCount(contextWindow);
  }
  return '未提供';
}

function formatCount(value: number) {
  return LOCALE_FORMATTER.format(Math.max(0, Math.round(value)));
}

function formatRatio(total: number, contextWindow: number) {
  if (!contextWindow) return '0.0%';
  return `${((total / contextWindow) * 100).toFixed(1)}%`;
}
