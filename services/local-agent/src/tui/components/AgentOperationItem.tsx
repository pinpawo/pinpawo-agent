import React from 'react';
import { Box, Text } from 'ink';
import {
  buildAgentOperationDisplayLines,
  type TimelineTextLine,
} from './agentTimelineRendering';
import type { AgentOperationEntry } from '../timeline/agentTimeline';

export function AgentOperationItem(props: {
  entry: AgentOperationEntry;
  now: number;
  width: number;
}) {
  const lines = buildAgentOperationDisplayLines(props.entry, props.now, props.width);
  const color = props.entry.phase === 'failed'
    ? 'red'
    : props.entry.phase === 'completed'
      ? 'green'
      : props.entry.phase === 'interrupted'
        ? 'yellow'
        : 'blue';

  return (
    <Box flexDirection="column" marginBottom={1}>
      {lines.map((line) => (
        <Text key={line.id} {...lineToneProps(line, color)}>
          {line.text}
        </Text>
      ))}
    </Box>
  );
}

function lineToneProps(line: TimelineTextLine, fallbackColor: string) {
  switch (line.tone) {
    case 'added':
      return { color: 'green' as const };
    case 'removed':
      return { color: 'red' as const };
    case 'muted':
      return { dimColor: true };
    case 'default':
    case undefined:
      return { color: fallbackColor, dimColor: true };
  }
}
