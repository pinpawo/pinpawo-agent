import React from 'react';
import { Box, Text } from 'ink';
import { AgentMessageItem } from './AgentMessageItem';
import { AgentOperationItem } from './AgentOperationItem';
import { buildAgentReviewText } from './agentTimelineRendering';
import { MessageBlock } from './MessageBlock';
import type { AgentTimelineEntry } from '../timeline/agentTimeline';

export function AgentTimelineItem(props: {
  entry: AgentTimelineEntry;
  petName: string;
  now: number;
  width: number;
}) {
  switch (props.entry.type) {
    case 'message':
      return <AgentMessageItem entry={props.entry} petName={props.petName} width={props.width} />;
    case 'operation':
      return <AgentOperationItem entry={props.entry} now={props.now} width={props.width} />;
    case 'review':
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="yellow" dimColor>
            {buildAgentReviewText(props.entry)}
          </Text>
        </Box>
      );
    case 'error':
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="red">{props.entry.text}</Text>
        </Box>
      );
    case 'studio.progress':
    case 'notice':
      return (
        <MessageBlock
          entry={{
            kind: 'system',
            timestamp: props.entry.createdAt,
            text: props.entry.text,
          }}
          petName={props.petName}
          width={props.width}
        />
      );
  }
}
