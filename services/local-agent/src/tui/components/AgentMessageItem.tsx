import React from 'react';
import { Box, Text } from 'ink';
import { MessageBlock } from './MessageBlock';
import { formatSubagentMessage } from '../render/eventText';
import { wrapLine } from '../render/terminalText';
import type { AgentMessageEntry } from '../timeline/agentTimeline';

function wrapText(text: string, width: number) {
  return text
    .split('\n')
    .flatMap((line) => wrapLine(line, width))
    .map((line) => line || ' ');
}

export function AgentMessageItem(props: {
  entry: AgentMessageEntry;
  petName: string;
  width: number;
}) {
  if (props.entry.role === 'subagent') {
    const text = formatSubagentMessage(props.entry.text);
    if (!text) return null;

    const timestamp = props.entry.updatedAt ?? props.entry.createdAt;
    const label = timestamp ? `[${timestamp}] subagent` : 'subagent';
    const contentWidth = Math.max(20, props.width - 4);

    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text color="yellow" dimColor>
          {label}
        </Text>
        <Box flexDirection="column" marginLeft={1} width={contentWidth}>
          {wrapText(text, contentWidth).map((line, index) => (
            <Text key={`${props.entry.id}:line:${index}`} color="yellow" dimColor>
              {line}
            </Text>
          ))}
        </Box>
      </Box>
    );
  }

  return (
    <MessageBlock
      entry={{
        kind: props.entry.role,
        timestamp: props.entry.updatedAt ?? props.entry.createdAt,
        text: props.entry.text,
      }}
      petName={props.petName}
      width={props.width}
    />
  );
}
