import type { AgentMessageEntry, AgentMessageToolCall, AgentTimelineEntry } from '@pinpawo/agent-session';
import { normalizeAssistantMessageMarkdown } from '../text/messageMarkdown';
import { formatSubagentProtocolMessage } from './subagentProtocolDisplay';

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
        ...(entry.text.trim() || !entry.toolCalls?.length ? logicalLines(
          normalizeAssistantMessageMarkdown(entry.text),
        ).map((line) => ({
          text: `| ${line}`,
          tone: 'assistant' as const,
        })) : []),
        ...buildToolCallDisplayLines(entry),
      ];
    case 'subagent':
      return [];
  }
}

/**
 * An assistant message in which the agent itself called tools. Its calls head
 * the work they started: the operations that follow are their content.
 */
export function isToolCallMessageEntry(entry: AgentTimelineEntry): entry is AgentMessageEntry {
  return entry.type === 'message' && entry.role === 'assistant' && Boolean(entry.toolCalls?.length);
}

/** Whether any of the message's calls still has work coming. */
export function hasOpenToolCalls(entry: { toolCalls?: readonly AgentMessageToolCall[] }) {
  return entry.toolCalls?.some(call => call.status === 'running') ?? false;
}

/**
 * One line per call: its title, plus the outcome when it did not complete. A
 * running or completed call shows the title alone, so the line the transcript
 * commits while it runs never has to be rewritten.
 */
export function buildToolCallDisplayLines(entry: AgentMessageEntry): MessageDisplayLine[] {
  return (entry.toolCalls ?? []).map(call => ({
    text: `▸ ${toolCallTitle(call)}${TOOL_CALL_OUTCOME[call.status] ? `（${TOOL_CALL_OUTCOME[call.status]}）` : ''}`,
    tone: 'assistant' as const,
  }));
}

/**
 * A call as one line: a fixed label for the handoff tools, else the tool's
 * name. Handoff arguments (Entry's restated goal, Supervisor's briefing) are
 * instructions for the next agent, not words for the user: the one sentence
 * meant for the user is the message's own text, and the current plan item
 * names the work.
 */
export function toolCallTitle(call: Pick<AgentMessageToolCall, 'name'>) {
  return TOOL_CALL_LABEL[call.name] ?? call.name;
}

const TOOL_CALL_LABEL: Record<string, string> = {
  delegate_capability: '交给能力执行',
  plan_request: '制定计划',
};

const TOOL_CALL_OUTCOME: Record<AgentMessageToolCall['status'], string> = {
  running: '',
  completed: '',
  failed: '失败',
  interrupted: '已中断',
};

export function subagentDisplayText(text: string) {
  return formatSubagentProtocolMessage(text) ?? text;
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
