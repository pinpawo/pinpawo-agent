import React from 'react';
import { Box, Text } from 'ink';
import { formatSubagentMessage } from '../render/eventText';
import { wrapLine } from '../render/terminalText';
import type { AgentMessageEntry } from '../timeline/agentTimeline';

function wrapText(text: string, width: number) {
  return text
    .split('\n')
    .flatMap((line) => wrapLine(line, width))
    .map((line) => line || ' ');
}

export function SubagentMessageItem(props: {
  entry: AgentMessageEntry;
  width: number;
}) {
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
