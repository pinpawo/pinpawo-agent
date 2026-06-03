import { Text } from 'ink';
import { TUI_TEXT } from '../render/text';
import type { SessionModel } from '../state/tuiState';

const LOCALE_FORMATTER = new Intl.NumberFormat('zh-CN');

function fallback(value: string | undefined) {
  const text = value?.trim();
  return text ? text : '未提供';
}

export function RuntimeInfoLine({ runtime }: { runtime: SessionModel['runtime'] }) {
  return (
    <Text dimColor>
      {TUI_TEXT.runtimeInfoLine(
        fallback(runtime.model),
        fallback(runtime.cwd),
        runtime.contextWindow ? LOCALE_FORMATTER.format(runtime.contextWindow) : '未提供',
      )}
    </Text>
  );
}

