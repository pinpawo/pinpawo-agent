import { Text } from 'ink';
import { TUI_TEXT } from '../render/text';
import type { TokenUsageModel } from '../state/tuiState';

const LOCALE_FORMATTER = new Intl.NumberFormat('zh-CN');

function formatTokenUsage(value: number) {
  return LOCALE_FORMATTER.format(Math.max(0, Math.round(value)));
}

export function TokenUsageLine({ tokenUsage }: { tokenUsage: TokenUsageModel }) {
  const ratio = tokenUsage.contextWindow
    ? `${((tokenUsage.totalTokens / tokenUsage.contextWindow) * 100).toFixed(1)}%`
    : null;

  return (
    <Text dimColor>
      {TUI_TEXT.tokenUsageLine(
        formatTokenUsage(tokenUsage.inputTokens),
        formatTokenUsage(tokenUsage.outputTokens),
        formatTokenUsage(tokenUsage.totalTokens),
        tokenUsage.contextWindow ? formatTokenUsage(tokenUsage.contextWindow) : null,
        ratio,
      )}
    </Text>
  );
}
