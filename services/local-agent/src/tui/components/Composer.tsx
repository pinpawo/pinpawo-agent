import { Box, Text } from 'ink';

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

  const rows = wrapComposerTextWithCursor(value, cursorOffset, visualWidth);

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

type WrappedLine = {
  text: string;
  start: number;
  end: number;
};

function wrapComposerText(text: string, width: number): WrappedLine[] {
  const rows: WrappedLine[] = [];
  let offset = 0;
  const logicalLines = text.split('\n');
  for (const [lineIndex, line] of logicalLines.entries()) {
    if (!line) {
      rows.push({ text: '', start: offset, end: offset });
    } else {
      for (let start = 0; start < line.length; start += width) {
        const chunk = line.slice(start, start + width);
        rows.push({ text: chunk, start: offset + start, end: offset + start + chunk.length });
      }
    }
    offset += line.length;
    if (lineIndex < logicalLines.length - 1) {
      offset += 1;
    }
  }
  return rows.length > 0 ? rows : [{ text: '', start: 0, end: 0 }];
}

function wrapComposerTextWithCursor(value: string, cursorOffset: number, width: number): Array<{
  before: string;
  cursor: string | null;
  after: string;
}> {
  let cursorRendered = false;
  return wrapComposerText(value, width).map((line) => {
    if (!cursorRendered && line.start === line.end && cursorOffset === line.start) {
      cursorRendered = true;
      return { before: '', cursor: ' ', after: '' };
    }
    if (!cursorRendered && cursorOffset >= line.start && cursorOffset < line.end) {
      const localOffset = cursorOffset - line.start;
      cursorRendered = true;
      return {
        before: line.text.slice(0, localOffset),
        cursor: value[cursorOffset] === '\n' ? ' ' : value[cursorOffset] ?? ' ',
        after: line.text.slice(localOffset + 1),
      };
    }
    if (
      !cursorRendered
      && cursorOffset === line.end
      && (cursorOffset === value.length || value[cursorOffset] === '\n')
    ) {
      cursorRendered = true;
      return { before: line.text, cursor: ' ', after: '' };
    }
    return { before: line.text, cursor: null, after: '' };
  });
}
