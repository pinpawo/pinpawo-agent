import { Box, Text } from 'ink';
import type { ReviewSpec } from '@pinpawo/pet-agent';
import { TUI_TEXT } from '../render/text';
import { wrapLine } from '../render/terminalText';

function formatReviewView(review: ReviewSpec) {
  return [
    review.view.title,
    review.view.body,
  ].filter((line): line is string => Boolean(line && line.trim())).join('\n');
}

export function ApprovalPanel(props: {
  review: ReviewSpec;
  petId?: string;
  width: number;
  selectedIndex: number;
}) {
  const options = props.review.options;
  const promptLines = wrapLine(formatReviewView(props.review), props.width - 4);
  const selectedIndex = Math.max(0, Math.min(options.length - 1, props.selectedIndex));

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
      {options.map((opt, i) => (
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
