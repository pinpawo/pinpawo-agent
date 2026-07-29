const SUBAGENT_TEXT_LINE_CHARS = 64;

export function formatSubagentMessage(text: string): string | null {
  const content = formatSubagentTextBody(text);
  return content || null;
}

function formatSubagentTextBody(text: string) {
  const normalized = text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!normalized) return '';

  return normalized
    .split(/\n{2,}/)
    .map((paragraph) => splitLongParagraph(paragraph.trim()).join('\n'))
    .filter(Boolean)
    .join('\n\n');
}

function splitLongParagraph(paragraph: string) {
  const sentences = paragraph.match(/[^。！？!?]+[。！？!?]?/g) ?? [paragraph];
  const lines: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    const item = sentence.trim();
    if (!item) continue;
    if (current && current.length + item.length > SUBAGENT_TEXT_LINE_CHARS) {
      lines.push(current);
      current = item;
      continue;
    }
    current = current ? `${current}${item}` : item;
  }
  if (current) lines.push(current);
  return lines;
}
