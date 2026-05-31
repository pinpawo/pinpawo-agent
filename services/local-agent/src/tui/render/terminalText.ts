import stringWidth from 'string-width';

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
