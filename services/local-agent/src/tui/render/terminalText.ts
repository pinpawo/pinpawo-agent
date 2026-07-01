import stringWidth from 'string-width';

export const MAX_REASONABLE_ELAPSED_MS = 24 * 60 * 60 * 1000;

export function formatNow() {
  return new Date().toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatElapsed(startedAt: number, now: number) {
  const elapsedMs = elapsedMsSince(startedAt, now);
  if (elapsedMs === null) return null;
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export function elapsedMsSince(startedAt: number, now: number) {
  if (!Number.isFinite(startedAt) || !Number.isFinite(now)) return null;
  const elapsedMs = now - startedAt;
  if (elapsedMs < 0) return 0;
  if (elapsedMs > MAX_REASONABLE_ELAPSED_MS) return null;
  return elapsedMs;
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

export function truncateLine(line: string, width: number) {
  if (width <= 0) return '';
  if (stringWidth(line) <= width) return line;
  if (width <= 1) return '…';

  const targetWidth = width - 1;
  let result = '';
  let resultWidth = 0;
  for (const char of Array.from(line)) {
    const charWidth = Math.max(1, stringWidth(char));
    if (resultWidth + charWidth > targetWidth) break;
    result += char;
    resultWidth += charWidth;
  }
  return `${result.trimEnd().replace(/[ ·:：-]+$/, '')}…`;
}
