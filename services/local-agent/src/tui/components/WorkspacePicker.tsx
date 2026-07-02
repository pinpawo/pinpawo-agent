import { Box, Text } from 'ink';
import { TUI_TEXT } from '../render/text';
import type { WorkspaceSummary } from '../types';

export function WorkspacePicker(props: {
  workspaces: WorkspaceSummary[];
  selectedIndex: number;
  loading: boolean;
  width: number;
}) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
      <Text color="cyan" bold>{TUI_TEXT.workspacePickerTitle}</Text>
      {props.loading ? (
        <Text dimColor>{TUI_TEXT.workspaceLoading}</Text>
      ) : props.workspaces.length === 0 ? (
        <Text dimColor>{TUI_TEXT.workspaceEmpty}</Text>
      ) : (
        props.workspaces.map((workspace, index) => {
          const selected = index === props.selectedIndex;
          const prefix = selected ? '›' : ' ';
          const badge = workspace.active ? ` ${TUI_TEXT.workspaceActiveBadge}` : '';
          return (
            <Box key={workspace.id} flexDirection="column">
              <Text color={selected ? 'cyan' : undefined} bold={selected}>
                {prefix} {truncate(workspace.name, Math.max(20, props.width - 4))}{badge}
              </Text>
              <Text dimColor>  {truncate(workspace.rootPath, Math.max(20, props.width - 4))}</Text>
            </Box>
          );
        })
      )}
      <Text dimColor>{TUI_TEXT.workspacePickerHelp}</Text>
    </Box>
  );
}

function truncate(value: string, max: number) {
  const normalized = value.replace(/\s+/g, ' ').trim() || '未命名 workspace';
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}
