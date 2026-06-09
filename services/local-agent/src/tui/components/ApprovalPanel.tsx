import { Box, Text } from 'ink';
import { TUI_TEXT } from '../render/text';
import { wrapLine } from '../render/terminalText';
import type { ApprovalOption } from '../types';

export function ApprovalPanel(props: {
  prompt: string;
  petId?: string;
  width: number;
  options: ApprovalOption[];
  selectedIndex: number;
}) {
  const promptLines = wrapLine(props.prompt, props.width - 4);
  const selectedIndex = Math.max(0, Math.min(props.options.length - 1, props.selectedIndex));

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      marginTop={1}
      width={props.width}
    >
      <Text color="yellow">
        {TUI_TEXT.approvalHeading(props.petId)}
      </Text>
      {promptLines.map((line, i) => (
        <Text key={`p-${i}`}>{line}</Text>
      ))}
      <Text>{' '}</Text>
      {props.options.map((opt, i) => (
        <Box key={`o-${i}`} flexDirection="column">
          <Text color={i === selectedIndex ? 'cyan' : undefined} bold={i === selectedIndex}>
            {i === selectedIndex ? '› ' : '  '}{opt.label}
            {opt.input ? ' …' : ''}
          </Text>
          {opt.description ? (
            <Text dimColor>
              {'    '}{opt.description}
            </Text>
          ) : null}
        </Box>
      ))}
      <Text>{' '}</Text>
      <Text dimColor>{TUI_TEXT.approvalHelp}</Text>
    </Box>
  );
}
