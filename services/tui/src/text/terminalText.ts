import stringWidth from 'string-width';

export function truncateTerminalLine(value: string, width: number) {
  const normalized = normalizeTerminalLine(value);
  if (width <= 0) return '';
  if (stringWidth(normalized) <= width) return normalized;
  if (width === 1) return '…';
  let result = '';
  let resultWidth = 0;
  for (const character of normalized) {
    const characterWidth = stringWidth(character);
    if (resultWidth + characterWidth > width - 1) break;
    result += character;
    resultWidth += characterWidth;
  }
  return `${result.trimEnd()}…`;
}

export function wrapTerminalText(
  value: string,
  width: number,
  maxLines = Number.POSITIVE_INFINITY,
) {
  if (width <= 0 || maxLines <= 0) return [];
  const normalized = value
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '�');
  const result: string[] = [];
  for (const logicalLine of normalized.split('\n')) {
    if (!logicalLine) {
      result.push('');
    } else {
      let line = '';
      let lineWidth = 0;
      for (const character of logicalLine) {
        const characterWidth = stringWidth(character);
        if (line && lineWidth + characterWidth > width) {
          result.push(line);
          line = '';
          lineWidth = 0;
          if (result.length >= maxLines) return result;
        }
        line += character;
        lineWidth += characterWidth;
      }
      result.push(line);
    }
    if (result.length >= maxLines) return result;
  }
  return result;
}

export function normalizeTerminalLine(value: string) {
  return value
    .replace(/\r\n?|\n/g, ' ↵ ')
    .replace(/\t/g, '  ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '�');
}
