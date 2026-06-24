import { Text } from 'ink';
import { TUI_TEXT } from '../render/text';
import type { SessionModel } from '../state/tuiState';

const LOCALE_FORMATTER = new Intl.NumberFormat('zh-CN');

function fallback(value: string | undefined) {
  const text = value?.trim();
  return text ? text : '未提供';
}

function studioSourceLabel(source: string | undefined) {
  if (source === 'workdir') return '工作区';
  if (source === 'legacy_home') return '旧全局';
  if (source === 'missing') return '缺失';
  return '未提供';
}

export function RuntimeInfoLine({ runtime }: { runtime: SessionModel['runtime'] }) {
  const studioConfigPath = runtime.studioConfigActivePath ?? runtime.studioConfigPath;
  return (
    <Text dimColor>
      {TUI_TEXT.runtimeInfoLine(
        fallback(runtime.model),
        fallback(runtime.cwd),
        fallback(studioConfigPath),
        studioSourceLabel(runtime.studioConfigSource),
        runtime.contextWindow ? LOCALE_FORMATTER.format(runtime.contextWindow) : '未提供',
      )}
    </Text>
  );
}
