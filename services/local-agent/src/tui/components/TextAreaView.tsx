import { Box, Text } from 'ink';
import type { TextAreaViewModel, TextAreaViewRow } from '../input/textarea/viewModel';

export function TextAreaView(props: { model: TextAreaViewModel }) {
  return (
    <Box flexDirection="column">
      {props.model.rows.map((row, index) => (
        <TextAreaViewLine key={index} row={row} />
      ))}
    </Box>
  );
}

function TextAreaViewLine(props: { row: TextAreaViewRow }) {
  const { row } = props;

  if (row.cursor === null) {
    return <Text dimColor={row.dim}>{row.before || ' '}</Text>;
  }

  return (
    <Text dimColor={row.dim}>
      {row.before}
      <Text inverse>{row.cursor}</Text>
      {row.dimAfterCursor ? <Text dimColor>{row.after}</Text> : row.after}
    </Text>
  );
}
