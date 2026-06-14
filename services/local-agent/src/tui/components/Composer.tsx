import { Box, Text } from 'ink';
import { renderTextAreaRows, wrapTextAreaRows } from '../input/textareaModel';

export function Composer(props: {
  value: string;
  cursorOffset: number;
  placeholder?: string;
  focus?: boolean;
  width?: number;
}) {
  const {
    value,
    placeholder = '',
    focus = true,
    width = 60,
  } = props;
  const cursorOffset = Math.max(0, Math.min(value.length, props.cursorOffset));
  const visualWidth = Math.max(1, width);

  if (!focus) {
    return (
      <Box flexDirection="column">
        {wrapComposerText(value || placeholder, visualWidth).map((line, index) => (
          <Text key={index} dimColor>{line.text || ' '}</Text>
        ))}
      </Box>
    );
  }

  if (!value) {
    if (placeholder) {
      return (
        <Text>
          <Text inverse>{placeholder[0] ?? ' '}</Text>
          <Text dimColor>{placeholder.slice(1)}</Text>
        </Text>
      );
    }
    return <Text inverse>{' '}</Text>;
  }

  const rows = renderTextAreaRows({ text: value, cursorOffset }, visualWidth);

  return (
    <Box flexDirection="column">
      {rows.map((row, index) => (
        <Text key={index}>
          {row.cursor === null
            ? row.before
            : <>{row.before}<Text inverse>{row.cursor}</Text>{row.after}</>}
        </Text>
      ))}
    </Box>
  );
}

function wrapComposerText(text: string, width: number) {
  return wrapTextAreaRows(text, width);
}
