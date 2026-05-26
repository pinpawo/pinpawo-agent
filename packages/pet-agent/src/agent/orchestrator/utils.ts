import type { AnnounceKind, DelegationStatus } from './types';

export function clipForPrompt(text: string, maxLength = 180): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

export function readMessageText(message: { content?: unknown }): string {
  const { content } = message;
  if (typeof content === 'string') {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
          return part.text;
        }
        return '';
      })
      .join('\n')
      .trim();
  }
  return '';
}

export function formatDelegationStatus(status: DelegationStatus): string {
  if (status === 'completed') return '已完成';
  if (status === 'progress') return '进行中';
  return '待执行';
}

export function describeAnnounceKind(kind: AnnounceKind): string {
  return kind === 'completed'
    ? 'completed：subagent 已完成它被委派的任务'
    : 'progress：subagent 只返回了阶段性结果，还不能视为任务完成';
}
