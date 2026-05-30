import { Text } from 'ink';

export function Composer(props: {
  value: string;
  cursorOffset: number;
  placeholder?: string;
  focus?: boolean;
}) {
  const {
    value,
    placeholder = '',
    focus = true,
  } = props;
  const cursorOffset = Math.max(0, Math.min(value.length, props.cursorOffset));

  if (!focus) {
    return <Text dimColor>{value || placeholder}</Text>;
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

  const before = value.slice(0, cursorOffset);
  const cursorChar = cursorOffset < value.length ? value[cursorOffset]! : ' ';
  const after = cursorOffset < value.length ? value.slice(cursorOffset + 1) : '';

  return (
    <Text>
      {before}<Text inverse>{cursorChar}</Text>{after}
    </Text>
  );
}
