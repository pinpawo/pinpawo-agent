import React from 'react';
import { Box, Text } from 'ink';
import { buildAgentOperationDisplayLines } from './agentTimelineRendering';
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
        <Text key={line.id} color={color} dimColor>
          {line.text}
        </Text>
      ))}
    </Box>
  );
}
