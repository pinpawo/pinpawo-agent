import { Text } from 'ink';
import { TUI_TEXT } from '../render/text';
import type { SessionModel } from '../state/tuiState';

const LOCALE_FORMATTER = new Intl.NumberFormat('zh-CN');

function fallback(value: string | undefined) {
  const text = value?.trim();
  return text ? text : '未提供';
}

function formatConnectionMode(mode: SessionModel['runtime']['connectionMode']) {
  if (mode === 'local-only') return '本地模式';
  if (mode === 'api-connected') return '联网模式';
  return '模式未提供';
}

export function RuntimeInfoLine({ runtime }: { runtime: SessionModel['runtime'] }) {
  return (
    <Text dimColor>
      {TUI_TEXT.runtimeInfoLine(
        fallback(runtime.model),
        fallback(runtime.cwd),
        runtime.contextWindow ? LOCALE_FORMATTER.format(runtime.contextWindow) : '未提供',
        formatConnectionMode(runtime.connectionMode),
      )}
    </Text>
  );
}
