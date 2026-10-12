import type { AgentMessageEntry, AgentMessageToolCall, AgentTimelineEntry } from '@pinpawo/agent-session';
import { normalizeAssistantMessageMarkdown } from '../text/messageMarkdown';
import { formatSubagentProtocolMessage } from './subagentProtocolDisplay';
import { truncateTerminalLine } from '../text/terminalText';

export type MessageDisplayTone =
  | 'assistant'
  | 'assistant-label'
  | 'system'
  | 'user'
  | 'user-label'
  | 'subagent'
  | 'removed';

export type MessageDisplayLine = {
  text: string;
  tone: MessageDisplayTone;
};

export function buildMessageDisplayLines(
  entry: AgentMessageEntry,
  options: { toolCallDetail?: boolean } = {},
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
        ...(options.toolCallDetail ? buildToolCallDetailLines(entry) : buildToolCallDisplayLines(entry)),
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
 * commits while it runs never has to be rewritten. A failed call's result
 * follows its outcome, since that is the reason the step stopped.
 */
export function buildToolCallDisplayLines(entry: AgentMessageEntry): MessageDisplayLine[] {
  return (entry.toolCalls ?? []).flatMap(call => [
    {
      text: `▸ ${toolCallTitle(call)}${TOOL_CALL_OUTCOME[call.status] ? `（${TOOL_CALL_OUTCOME[call.status]}）` : ''}`,
      tone: 'assistant' as const,
    },
    ...(call.status === 'failed' ? toolCallErrorLines(call.error) : []),
  ]);
}

/**
 * A call as one line: what the step is, then a glimpse of what it was given.
 * Handoff arguments (Entry's restated goal, Supervisor's briefing) are
 * instructions for the next agent, so the line names the step first and keeps
 * the argument to a short, single-line preview; the transcript (PageUp) holds
 * it in full.
 */
export function toolCallTitle(call: Pick<AgentMessageToolCall, 'name' | 'args'>) {
  const label = TOOL_CALL_LABEL[call.name] ?? call.name;
  const subject = toolCallSubject(call);
  return subject ? `${label} · ${truncateTerminalLine(subject.replace(/\s+/g, ' ').trim(), TOOL_CALL_SUBJECT_WIDTH)}` : label;
}

/**
 * The full text behind each call's line, for the transcript (PageUp): what the
 * call was given and, when it failed, everything it returned.
 */
export function buildToolCallDetailLines(entry: AgentMessageEntry): MessageDisplayLine[] {
  return (entry.toolCalls ?? []).flatMap(call => [
    {
      text: `▸ ${TOOL_CALL_LABEL[call.name] ?? call.name}${TOOL_CALL_OUTCOME[call.status] ? `（${TOOL_CALL_OUTCOME[call.status]}）` : ''}`,
      tone: 'assistant' as const,
    },
    ...indent(TOOL_CALL_DETAIL[call.name]?.(call.args) ?? JSON.stringify(call.args, null, 2))
      .map(text => ({ text, tone: 'assistant' as const })),
    ...(call.status === 'failed' && call.error?.trim()
      ? indent(call.error.trim(), 4).map((text, index) => ({ text: index === 0 ? `  ⎿ ${text.trimStart()}` : text, tone: 'removed' as const }))
      : []),
  ]);
}

const TOOL_CALL_LABEL: Record<string, string> = {
  delegate_capability: '交给能力执行',
  plan_request: '制定计划',
};

const TOOL_CALL_DETAIL: Record<string, (args: Record<string, unknown>) => string | null> = {
  delegate_capability: args => typeof args.briefing === 'string' ? args.briefing : null,
  plan_request: args => typeof args.goal === 'string' ? args.goal : null,
};

const TOOL_CALL_SUBJECT_WIDTH = 48;
const TOOL_CALL_ERROR_MAX_LINES = 6;

function toolCallSubject(call: Pick<AgentMessageToolCall, 'name' | 'args'>) {
  const detail = TOOL_CALL_DETAIL[call.name]?.(call.args);
  // A briefing often opens with a Markdown heading ("## 任务"); the first line
  // with content says more.
  return detail?.split('\n').map(line => line.trim()).find(line => line && !/^#{1,6}(\s|$)/.test(line)) ?? null;
}

function toolCallErrorLines(error: string | undefined): MessageDisplayLine[] {
  const lines = error?.trim() ? error.trim().split('\n') : [];
  const visible = lines.slice(0, TOOL_CALL_ERROR_MAX_LINES);
  const hidden = lines.length - visible.length;
  return [
    ...visible.map((line, index) => ({ text: `${index === 0 ? '  ⎿ ' : '    '}${line}`, tone: 'removed' as const })),
    ...(hidden > 0 ? [{ text: `    … +${hidden} lines`, tone: 'system' as const }] : []),
  ];
}

function indent(text: string, width = 2) {
  return text.split('\n').map(line => `${' '.repeat(width)}${line}`);
}

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
