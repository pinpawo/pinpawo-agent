import React from 'react';
import { Box, Text } from 'ink';
import { AgentTimelineItem } from './AgentTimelineItem';
import { TUI_TEXT } from '../render/text';
import type { AgentTimelineEntry } from '../timeline/agentTimeline';

export function AgentTimeline(props: {
  entries: AgentTimelineEntry[];
  petName: string;
  width: number;
  now: number;
}) {
  if (props.entries.length === 0) {
    return <Text dimColor>{TUI_TEXT.emptyHistory(props.petName)}</Text>;
  }

  return (
    <Box flexDirection="column">
      {props.entries.map((entry) => (
        <AgentTimelineItem
          key={entry.id}
          entry={entry}
          petName={props.petName}
          now={props.now}
          width={props.width}
        />
      ))}
    </Box>
  );
}
