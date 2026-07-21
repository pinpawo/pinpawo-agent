import React from 'react';
import { Text } from 'ink';
import type { TokenUsageSnapshot } from '@pinpawo/pet-agent';
import { TUI_TEXT } from '../render/text';

const LOCALE_FORMATTER = new Intl.NumberFormat('zh-CN');

function formatTokenUsage(value: number) {
  return LOCALE_FORMATTER.format(Math.max(0, Math.round(value)));
}

export function TokenUsageLine({ tokenUsage }: { tokenUsage: TokenUsageSnapshot }) {
  const ratio = tokenUsage.scope === undefined && tokenUsage.contextWindow
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
        tokenUsage.source,
        tokenUsage.scope,
      )}
    </Text>
  );
}
