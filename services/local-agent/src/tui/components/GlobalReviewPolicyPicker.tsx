import { Box, Text } from 'ink';
import type { BuiltinGlobalReviewPolicyMode } from '@pinpawo/pet-agent';
import { TUI_TEXT } from '../render/text';
import {
  GLOBAL_REVIEW_POLICY_PICKER_OPTIONS,
  findGlobalReviewPolicyPickerIndex,
} from '../globalReviewPolicyPicker';

export function GlobalReviewPolicyPicker(props: {
  currentMode: BuiltinGlobalReviewPolicyMode;
  selectedIndex: number;
  width: number;
}) {
  const currentIndex = findGlobalReviewPolicyPickerIndex(props.currentMode);
  const selectedIndex = Math.max(
    0,
    Math.min(GLOBAL_REVIEW_POLICY_PICKER_OPTIONS.length - 1, props.selectedIndex),
  );

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
      <Text color="cyan" bold>{TUI_TEXT.globalReviewPolicyPickerTitle}</Text>
      {GLOBAL_REVIEW_POLICY_PICKER_OPTIONS.map((option, index) => {
        const selected = index === selectedIndex;
        const current = index === currentIndex;
        const prefix = selected ? '›' : ' ';
        const badge = current ? ` ${TUI_TEXT.globalReviewPolicyCurrentBadge}` : '';
        return (
          <Box key={option.mode} flexDirection="column">
            <Text color={selected ? 'cyan' : current ? 'green' : undefined} bold={selected}>
              {prefix} {option.label}{badge}
            </Text>
            <Text dimColor>  {truncate(option.detail, Math.max(20, props.width - 6))}</Text>
          </Box>
        );
      })}
      <Text dimColor>{TUI_TEXT.globalReviewPolicyPickerHelp}</Text>
    </Box>
  );
}

function truncate(value: string, max: number) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}
