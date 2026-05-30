import { useEffect, useState } from 'react';
import { Text, useInput } from 'ink';

export function SmartTextInput(props: {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  placeholder?: string;
  focus?: boolean;
}) {
  const { value, onChange, onSubmit, placeholder = '', focus = true } = props;
  const [cursorOffset, setCursorOffset] = useState(value.length);

  useEffect(() => {
    setCursorOffset((prev) => Math.min(prev, value.length));
  }, [value]);

  useInput((input, key) => {
    if (key.upArrow || key.downArrow || key.tab || (key.shift && key.tab)) return;
    if (key.ctrl && input === 'c') return; // let parent handle
    if (key.escape) return; // let parent handle

    if (key.return) {
      onSubmit?.(value);
      return;
    }

    let nextValue = value;
    let nextCursor = cursorOffset;

    if (key.ctrl) {
      switch (input) {
        case 'a':
          nextCursor = 0;
          break;
        case 'e':
          nextCursor = value.length;
          break;
        case 'k':
          nextValue = value.slice(0, cursorOffset);
          break;
        case 'u':
          nextValue = value.slice(cursorOffset);
          nextCursor = 0;
          break;
        case 'w': {
          const before = value.slice(0, cursorOffset);
          const trimmed = before.replace(/\s+$/, '');
          const wordStart = Math.max(0, trimmed.lastIndexOf(' ') + 1);
          nextValue = value.slice(0, wordStart) + value.slice(cursorOffset);
          nextCursor = wordStart;
          break;
        }
        default:
          return;
      }
    } else if (key.leftArrow) {
      nextCursor = Math.max(0, cursorOffset - 1);
    } else if (key.rightArrow) {
      nextCursor = Math.min(value.length, cursorOffset + 1);
    } else if (key.backspace || key.delete) {
      if (cursorOffset > 0) {
        nextValue = value.slice(0, cursorOffset - 1) + value.slice(cursorOffset);
        nextCursor = cursorOffset - 1;
      }
    } else {
      nextValue = value.slice(0, cursorOffset) + input + value.slice(cursorOffset);
      nextCursor = cursorOffset + input.length;
    }

    nextCursor = Math.max(0, Math.min(nextValue.length, nextCursor));
    setCursorOffset(nextCursor);
    if (nextValue !== value) {
      onChange(nextValue);
    }
  }, { isActive: focus });

  // Render: no focus or empty+unfocused -> placeholder
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
