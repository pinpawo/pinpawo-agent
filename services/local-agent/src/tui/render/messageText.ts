const LONG_SEPARATOR_RE = /^\s*[-=─]{10,}\s*$/u;

export function normalizeAssistantMessageMarkdown(text: string) {
  const lines = text.split('\n');
  const normalized: string[] = [];
  let index = 0;
  let inFence = false;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (line.trim().startsWith('```')) {
      inFence = !inFence;
      normalized.push(line);
      index += 1;
      continue;
    }

    if (!inFence) {
      const header = parseMarkdownTableRow(line);
      const separator = parseMarkdownTableSeparator(lines[index + 1]);
      if (header && separator) {
        const rows: string[][] = [];
        index += 2;
        while (index < lines.length) {
          const row = parseMarkdownTableRow(lines[index]);
          if (!row) break;
          rows.push(row);
          index += 1;
        }
        normalized.push(...formatMarkdownTableRows(header, rows));
        continue;
      }

      if (LONG_SEPARATOR_RE.test(line)) {
        normalized.push('. . .');
        index += 1;
        continue;
      }
    }

    normalized.push(line);
    index += 1;
  }

  return normalized.join('\n');
}

function parseMarkdownTableRow(line: string | undefined) {
  if (typeof line !== 'string') return null;
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return null;
  const body = trimmed
    .replace(/^\|/, '')
    .replace(/\|$/, '');
  const cells = body.split('|').map((cell) => cell.trim());
  return cells.length >= 2 ? cells : null;
}

function parseMarkdownTableSeparator(line: string | undefined) {
  const cells = parseMarkdownTableRow(line);
  if (!cells) return false;
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, '')));
}

function formatMarkdownTableRows(headers: string[], rows: string[][]) {
  if (rows.length === 0) {
    return [headers.filter(Boolean).join(' | ')];
  }

  return rows.map((row) => {
    const hasOrdinal = isOrdinalColumn(headers[0], row[0]);
    const startIndex = hasOrdinal ? 1 : 0;
    const parts = row
      .slice(startIndex)
      .map((cell, offset) => formatCell(headers[startIndex + offset], cell))
      .filter(Boolean);

    if (hasOrdinal) {
      const ordinal = row[0].replace(/[.．]$/u, '').trim();
      return `${ordinal}. ${parts.join(' · ') || '-'}`;
    }

    return `- ${parts.join(' · ') || '-'}`;
  });
}

function isOrdinalColumn(header: string | undefined, cell: string | undefined) {
  const normalizedHeader = (header ?? '').trim().toLowerCase();
  const normalizedCell = (cell ?? '').trim();
  return (
    normalizedCell.length > 0
    && /^(#|no\.?|序号|编号|index)$/iu.test(normalizedHeader)
    && /^\d+[.．]?$/u.test(normalizedCell)
  );
}

function formatCell(header: string | undefined, cell: string | undefined) {
  const value = (cell ?? '').trim();
  if (!value) return '';
  const label = (header ?? '').trim();
  return label ? `${label}: ${value}` : value;
}
