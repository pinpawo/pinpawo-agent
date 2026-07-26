const MAX_PREVIEW_CODE_POINTS = 120;

export function formatInputProbe(
  kind: 'key' | 'paste',
  value: string,
) {
  const preview = [...value]
    .slice(0, MAX_PREVIEW_CODE_POINTS)
    .map(escapeCodePoint)
    .join('');
  const truncated = [...value].length > MAX_PREVIEW_CODE_POINTS ? '…' : '';
  return `${kind}: ${preview}${truncated}`;
}

function escapeCodePoint(value: string) {
  const codePoint = value.codePointAt(0);
  if (codePoint === undefined) return '';
  if (value === '\n') return '\\n';
  if (value === '\r') return '\\r';
  if (value === '\t') return '\\t';
  if (codePoint === 0x1b) return '\\x1b';
  if (codePoint < 0x20 || codePoint === 0x7f) {
    return `\\x${codePoint.toString(16).padStart(2, '0')}`;
  }
  return value;
}
