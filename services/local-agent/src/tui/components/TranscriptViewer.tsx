import React from 'react';
import { Box, Text } from 'ink';
import type { LocalAgentTimelineEntry } from '../../localAgentSession';
import { maxTimelineScrollOffset } from '../timeline/timelineScroll';
import { AgentTimelineItem } from './AgentTimelineItem';
import { TimelineViewport } from './TimelineViewport';

export function TranscriptViewer(props: {
  entries: LocalAgentTimelineEntry[];
  petName: string;
  now: number;
  width: number;
  height: number;
  scrollOffset: number;
  contentVersion: unknown;
  layoutVersion: unknown;
  contentHeight: number;
  viewportHeight: number;
  onMetricsChange: (metrics: {
    contentHeight: number;
    viewportHeight: number;
  }) => void;
}) {
  const maxOffset = maxTimelineScrollOffset(props.contentHeight, props.viewportHeight);
  const position = maxOffset === 0
    ? '全部'
    : props.scrollOffset === 0
      ? '底部'
      : `上移 ${props.scrollOffset}/${maxOffset} 行`;

  return (
    <Box
      flexDirection="column"
      height={Math.max(6, props.height)}
      overflow="hidden"
      paddingX={1}
    >
      <Box flexShrink={0} justifyContent="space-between">
        <Text bold color="cyan">Transcript</Text>
        <Text dimColor>{props.petName} · {props.entries.length} 项 · {position}</Text>
      </Box>
      <Box flexShrink={0}>
        <Text dimColor>{'─'.repeat(Math.max(1, props.width))}</Text>
      </Box>
      <TimelineViewport
        contentVersion={props.contentVersion}
        layoutVersion={props.layoutVersion}
        scrollOffset={props.scrollOffset}
        onMetricsChange={props.onMetricsChange}
      >
        {props.entries.length === 0 ? (
          <Text dimColor>当前会话还没有 transcript。</Text>
        ) : props.entries.map((entry) => (
          <Box key={entry.id} flexShrink={0}>
            <AgentTimelineItem
              entry={entry}
              petName={props.petName}
              now={props.now}
              width={props.width}
            />
          </Box>
        ))}
      </TimelineViewport>
      <Box flexShrink={0}>
        <Text dimColor>
          ↑↓/触控板 滚动 · PgUp/PgDn 翻页 · Home/End 顶部/底部 · Esc/q 返回
        </Text>
      </Box>
    </Box>
  );
}
