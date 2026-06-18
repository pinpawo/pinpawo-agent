import { Box, Text } from 'ink';
import { TUI_TEXT } from '../render/text';
import type { FileMentionModel } from '../input/fileMention';

export function FileMentionPopup(props: {
  model: FileMentionModel;
  width: number;
}) {
  if (!props.model.open) return null;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
      <Text color="cyan" bold>{TUI_TEXT.fileMentionTitle}</Text>
      {props.model.items.length === 0 ? (
        <Text dimColor>{TUI_TEXT.fileMentionEmpty}</Text>
      ) : (
        props.model.items.map((item, index) => {
          const selected = index === props.model.selectedIndex;
          const prefix = selected ? '›' : ' ';
          const label = `${item.type === 'directory' ? 'dir ' : 'file'} ${truncate(item.path, Math.max(20, props.width - 8))}`;
          return (
            <Text key={item.path} color={selected ? 'cyan' : undefined} bold={selected}>
              {prefix} {label}
            </Text>
          );
        })
      )}
    </Box>
  );
}

function truncate(value: string, max: number) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}
