import React from 'react';
import { Box, Text } from 'ink';
import Markdown from '@inkkit/ink-markdown';
import type { AgentMessageEntry } from '@pinpawo/agent-session';
import { normalizeAssistantMessageMarkdown } from '../render/messageText';
import { formatMessageTimestamp } from '../render/terminalText';

type MessageBlockEntry = Pick<
  AgentMessageEntry,
  'text' | 'createdAt' | 'updatedAt'
> & {
  role: Exclude<AgentMessageEntry['role'], 'subagent'>;
};

export function MessageBlock(props: {
  entry: MessageBlockEntry;
  petName: string;
  width: number;
}) {
  const rawTimestamp = props.entry.updatedAt ?? props.entry.createdAt;
  const timestamp = rawTimestamp ? `[${formatMessageTimestamp(rawTimestamp)}]` : '';
  const contentWidth = Math.max(20, props.width - 4);

  if (props.entry.role === 'system') {
    return (
      <Box flexDirection="column" marginBottom={1}>
        {props.entry.text.split('\n').map((line, index) => (
          <Text key={`${rawTimestamp ?? 'system'}-${index}`} color="yellow" dimColor>
            {index === 0 ? `${timestamp} system  ` : '                 '}
            {line || ' '}
          </Text>
        ))}
      </Box>
    );
  }

  if (props.entry.role === 'user') {
    const label = `${timestamp} 你`;
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text color="green" bold>{label}</Text>
        <Box marginLeft={1}>
          <Text color="green" dimColor>&gt; </Text>
          <Box flexDirection="column" width={contentWidth}>
            {props.entry.text.split('\n').map((line, index) => (
              <Text key={`${rawTimestamp ?? 'user'}-${index}`} color="green">
                {line || ' '}
              </Text>
            ))}
          </Box>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="green" bold>
        {timestamp} {props.petName}
      </Text>
      <Box marginLeft={1}>
        <Text color="green" dimColor>| </Text>
        <Box flexDirection="column" width={contentWidth}>
          <Markdown showSectionPrefix={false}>
            {normalizeAssistantMessageMarkdown(props.entry.text)}
          </Markdown>
        </Box>
      </Box>
    </Box>
  );
}
