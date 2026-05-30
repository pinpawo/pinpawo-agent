import stringWidth from 'string-width';
import type { ActiveTool, PendingUiState } from '../types';

export function formatNow() {
  return new Date().toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatElapsed(startedAt: number, now: number) {
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function buildBusyPhaseLabel(pending: PendingUiState, now: number) {
  if (pending.phase === 'interrupting') return '正在打断';
  if (pending.phase === 'replying') return '正在回复';
  const elapsedMs = now - pending.startedAt;
  if (elapsedMs < 3000) return '正在思考';
  if (elapsedMs < 10000) return '正在调用能力或工具';
  return '仍在处理中';
}

export function buildBusyStatusLine(
  pending: PendingUiState,
  now: number,
  spinnerFrame: string,
  activeTools: ActiveTool[],
) {
  const phase = buildBusyPhaseLabel(pending, now);
  const elapsed = formatElapsed(pending.startedAt, now);
  const detail = pending.charCount > 0 ? ` · ${pending.charCount} 字` : '';
  const tools = activeTools.length > 0 ? ` · ${activeTools.map((tool) => tool.name).join(', ')}` : '';
  return `${spinnerFrame} ${phase} · ${elapsed}${detail}${tools}`;
}

export function wrapLine(line: string, width: number) {
  if (width <= 0) return [''];
  if (!line) return [''];
  const wrapped: string[] = [];
  let current = '';
  let currentWidth = 0;
  for (const char of Array.from(line)) {
    const charWidth = Math.max(1, stringWidth(char));
    if (currentWidth > 0 && currentWidth + charWidth > width) {
      wrapped.push(current);
      current = char;
      currentWidth = charWidth;
      continue;
    }
    current += char;
    currentWidth += charWidth;
  }
  if (current || wrapped.length === 0) {
    wrapped.push(current);
  }
  return wrapped;
}

export function buildActiveToolLines(activeTools: ActiveTool[], now: number, width: number) {
  return activeTools.flatMap((tool, index) =>
    wrapLine(
      `${tool.label} · ${formatElapsed(tool.startedAt, now)}${tool.detail ? ` · ${tool.detail}` : ''}`,
      width,
    ).map((text, lineIndex) => ({
      id: `tool-${tool.name}-${index}-${lineIndex}`,
      text,
    })),
  );
}
