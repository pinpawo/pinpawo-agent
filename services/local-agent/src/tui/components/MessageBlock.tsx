import { Box, Text } from 'ink';
import Markdown from '@inkkit/ink-markdown';
import { normalizeAssistantMessageMarkdown } from '../render/messageText';
import { wrapLine } from '../render/terminalText';
import type { MessageEntry } from '../types';

const SUBAGENT_OUTPUT_PREFIX = '[subagent]\n';

function readSubagentOutput(text: string) {
  return text.startsWith(SUBAGENT_OUTPUT_PREFIX)
    ? text.slice(SUBAGENT_OUTPUT_PREFIX.length).trim()
    : null;
}

function wrapText(text: string, width: number) {
  return text
    .split('\n')
    .flatMap((line) => wrapLine(line, width))
    .map((line) => line || ' ');
}

export function MessageBlock(props: {
  entry: Pick<MessageEntry, 'kind' | 'timestamp' | 'text'>;
  petName: string;
  width: number;
}) {
  const timestamp = props.entry.timestamp ? `[${props.entry.timestamp}]` : '';
  const contentWidth = Math.max(20, props.width - 4);

  if (props.entry.kind === 'system') {
    const subagentOutput = readSubagentOutput(props.entry.text);
    if (subagentOutput) {
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="yellow" dimColor>
            {timestamp ? `${timestamp} subagent` : 'subagent'}
          </Text>
          <Box flexDirection="column" marginLeft={1} width={contentWidth}>
            {wrapText(subagentOutput, contentWidth).map((line, index) => (
              <Text key={`${props.entry.timestamp ?? 'subagent'}-${index}`} color="yellow" dimColor>
                {line}
              </Text>
            ))}
          </Box>
        </Box>
      );
    }

    return (
      <Box flexDirection="column" marginBottom={1}>
        {props.entry.text.split('\n').map((line, index) => (
          <Text key={`${props.entry.timestamp ?? 'system'}-${index}`} color="yellow" dimColor>
            {index === 0 ? `${timestamp} system  ` : '                 '}
            {line || ' '}
          </Text>
        ))}
      </Box>
    );
  }

  if (props.entry.kind === 'user') {
    const label = `${timestamp} 你`;
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text color="cyan" bold>{label}</Text>
        <Box marginLeft={1}>
          <Text color="cyan" dimColor>&gt; </Text>
          <Box flexDirection="column" width={contentWidth}>
            {props.entry.text.split('\n').map((line, index) => (
              <Text key={`${props.entry.timestamp ?? 'user'}-${index}`} color="cyan">
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
          <Markdown>{normalizeAssistantMessageMarkdown(props.entry.text)}</Markdown>
        </Box>
      </Box>
    </Box>
  );
}
