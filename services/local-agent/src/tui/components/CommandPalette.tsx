import { Box, Text } from 'ink';
import { TUI_TEXT } from '../render/text';
import type { CommandPaletteModel } from '../input/commandPalette';

const MAX_VISIBLE_COMMANDS = 6;

export function CommandPalette(props: {
  model: CommandPaletteModel;
  width: number;
}) {
  if (!props.model.open) return null;

  const visibleItems = props.model.items.slice(0, MAX_VISIBLE_COMMANDS);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
      <Text color="cyan" bold>{TUI_TEXT.commandPaletteTitle}</Text>
      {visibleItems.length === 0 ? (
        <Text dimColor>{TUI_TEXT.commandPaletteEmpty}</Text>
      ) : (
        visibleItems.map((command, index) => {
          const selected = index === props.model.selectedIndex;
          const prefix = selected ? '›' : ' ';
          return (
            <Box key={command.name} flexDirection="column">
              <Text color={selected ? 'cyan' : undefined} bold={selected}>
                {prefix} {command.usage}
              </Text>
              <Text dimColor>  {truncate(command.description, Math.max(20, props.width - 6))}</Text>
            </Box>
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
