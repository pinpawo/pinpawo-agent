export function normalizeText(input: string | null | undefined): string {
  if (!input) return '';
  return input.replace(/\s+/g, ' ').trim();
}

function tokenize(text: string): Set<string> {
  const normalized = normalizeText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) {
    return new Set();
  }

  return new Set(normalized.split(' ').filter(Boolean));
}

export function jaccardSimilarity(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);

  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;

  let intersection = 0;
  ta.forEach((token) => {
    if (tb.has(token)) {
      intersection += 1;
    }
  });

  const union = ta.size + tb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
