import type { AgentMessageEntry } from '@pinpawo/agent-session';
import { normalizeAssistantMessageMarkdown } from '../text/messageMarkdown';

export type MessageDisplayTone =
  | 'assistant'
  | 'assistant-label'
  | 'system'
  | 'user'
  | 'user-label'
  | 'subagent';

export type MessageDisplayLine = {
  text: string;
  tone: MessageDisplayTone;
};

export function buildMessageDisplayLines(
  entry: AgentMessageEntry,
): MessageDisplayLine[] {
  const timestamp = entry.updatedAt ?? entry.createdAt;
  const timestampLabel = timestamp
    ? `[${formatMessageTimestamp(timestamp)}]`
    : '';

  switch (entry.role) {
    case 'system':
      return logicalLines(entry.text).map((line, index) => ({
        text: index === 0
          ? joinLabel(timestampLabel, 'system', line)
          : `                 ${line}`,
        tone: 'system',
      }));
    case 'user':
      return [
        ...timestampLine(timestampLabel, 'user-label'),
        ...logicalLines(entry.text).map((line) => ({
          // Align user text with the two-cell gutter used by rich agent
          // messages while keeping its timestamp aligned with every entry.
          text: `  ${line}`,
          tone: 'user' as const,
        })),
      ];
    case 'assistant':
      return [
        ...timestampLine(timestampLabel, 'assistant-label'),
        ...logicalLines(
          normalizeAssistantMessageMarkdown(entry.text),
        ).map((line) => ({
          text: `| ${line}`,
          tone: 'assistant' as const,
        })),
      ];
    case 'subagent': {
      if (!entry.text.trim()) return [];
      return [
        ...timestampLine(timestampLabel, 'subagent'),
        ...logicalLines(
          normalizeAssistantMessageMarkdown(entry.text),
        ).map((line) => ({
          text: line,
          tone: 'subagent' as const,
        })),
      ];
    }
  }
}

export function formatMessageTimestamp(timestamp: string) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return date.toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function logicalLines(text: string) {
  return text.split('\n').map((line) => line || ' ');
}

function joinLabel(...parts: string[]) {
  return parts.filter(Boolean).join(' ');
}

function timestampLine(
  timestampLabel: string,
  tone: Extract<
    MessageDisplayTone,
    'assistant-label' | 'subagent' | 'user-label'
  >,
): MessageDisplayLine[] {
  return timestampLabel ? [{ text: timestampLabel, tone }] : [];
}
