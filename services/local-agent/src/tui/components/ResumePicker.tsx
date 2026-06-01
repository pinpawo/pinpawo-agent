import { Box, Text } from 'ink';
import { TUI_TEXT } from '../render/text';
import type { ResumeSessionSummary } from '../types';

export function ResumePicker(props: {
  sessions: ResumeSessionSummary[];
  selectedIndex: number;
  loading: boolean;
  width: number;
}) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1} marginTop={1}>
      <Text color="blue" bold>{TUI_TEXT.resumePickerTitle}</Text>
      {props.loading ? (
        <Text dimColor>{TUI_TEXT.resumeLoading}</Text>
      ) : props.sessions.length === 0 ? (
        <Text dimColor>{TUI_TEXT.resumeEmpty}</Text>
      ) : (
        props.sessions.map((session, index) => {
          const selected = index === props.selectedIndex;
          const prefix = selected ? '›' : ' ';
          const badge = session.active ? ` ${TUI_TEXT.resumeActiveBadge}` : '';
          const meta = `${session.messageCount} 条 · ${formatSessionTime(session.updatedAt)}${badge}`;
          return (
            <Box key={session.id} flexDirection="column">
              <Text color={selected ? 'cyan' : undefined} bold={selected}>
                {prefix} {truncate(session.title, Math.max(20, props.width - 4))}
              </Text>
              <Text dimColor>  {meta}</Text>
            </Box>
          );
        })
      )}
      <Text dimColor>{TUI_TEXT.resumePickerHelp}</Text>
    </Box>
  );
}

function truncate(value: string, max: number) {
  const normalized = value.replace(/\s+/g, ' ').trim() || '未命名会话';
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function formatSessionTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
