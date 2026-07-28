import type { AgentMessageEntry } from '@pinpawo/agent-session';
import { normalizeAgentLabel } from '../session/sessionDisplay';
import { normalizeAssistantMessageMarkdown } from '../text/messageMarkdown';
import { formatSubagentMessage } from './subagentDisplay';

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
  actorLabel = 'assistant',
): MessageDisplayLine[] {
  const safeActorLabel = normalizeAgentLabel(actorLabel, 'assistant');
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
      return [{
        text: joinLabel(timestampLabel, '你'),
        tone: 'user-label',
      }, ...logicalLines(entry.text).map((line, index) => ({
        text: `${index === 0 ? '> ' : '  '}${line}`,
        tone: 'user' as const,
      }))];
    case 'assistant':
      return [{
        text: joinLabel(timestampLabel, safeActorLabel),
        tone: 'assistant-label',
      }, ...logicalLines(
        normalizeAssistantMessageMarkdown(entry.text),
      ).map((line) => ({
        text: `| ${line}`,
        tone: 'assistant' as const,
      }))];
    case 'subagent': {
      const text = formatSubagentMessage(entry.text);
      if (!text) return [];
      return [{
        text: joinLabel(timestampLabel, 'subagent'),
        tone: 'subagent',
      }, ...logicalLines(text).map((line) => ({
        text: `  ${line}`,
        tone: 'subagent' as const,
      }))];
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
