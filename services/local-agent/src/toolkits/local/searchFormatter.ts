import type { GlobBackendResult, GrepBackendResult, SearchLine } from './searchBackend';

export const SEARCH_MAX_OUTPUT_BYTES = 50_000;
export const SEARCH_MAX_LINE_BYTES = 2_000;
const NOTICE_RESERVE_BYTES = 1_000;

function utf8Bytes(value: string) {
  return Buffer.byteLength(value, 'utf-8');
}

function truncateUtf8(value: string, maxBytes: number) {
  if (utf8Bytes(value) <= maxBytes) return value;
  const codePoints = Array.from(value);
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8Bytes(codePoints.slice(0, middle).join('')) <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return codePoints.slice(0, low).join('');
}

function formatSearchLine(item: SearchLine) {
  const separator = item.isMatch ? ':' : '-';
  const prefix = `${item.path}${separator}${item.lineNumber}${separator} `;
  const hint = ` …[line truncated; use view_file_chunk with this path and startLine=${item.lineNumber} endLine=${item.lineNumber}]`;
  const complete = `${prefix}${item.line}`;
  if (!item.backendTruncated && utf8Bytes(complete) <= SEARCH_MAX_LINE_BYTES) {
    return complete;
  }

  const contentBudget = Math.max(0, SEARCH_MAX_LINE_BYTES - utf8Bytes(prefix) - utf8Bytes(hint));
  if (contentBudget > 0) {
    return `${prefix}${truncateUtf8(item.line, contentBudget)}${hint}`;
  }
  return `${truncateUtf8(prefix, Math.max(0, SEARCH_MAX_LINE_BYTES - utf8Bytes(hint)))}${hint}`;
}

function boundedOutput(
  entries: string[],
  initialNotices: string[],
  byteLimitNotice: string,
  maxBytes = SEARCH_MAX_OUTPUT_BYTES,
) {
  const bodyBudget = Math.max(0, maxBytes - NOTICE_RESERVE_BYTES);
  const accepted: string[] = [];
  let bodyBytes = 0;
  let truncatedByBytes = false;

  for (const entry of entries) {
    const addition = `${accepted.length > 0 ? '\n' : ''}${entry}`;
    if (bodyBytes + utf8Bytes(addition) > bodyBudget) {
      truncatedByBytes = true;
      break;
    }
    accepted.push(entry);
    bodyBytes += utf8Bytes(addition);
  }

  const notices = [...initialNotices, ...(truncatedByBytes ? [byteLimitNotice] : [])];
  const output = [accepted.join('\n'), ...notices.map((notice) => `[${notice}]`)]
    .filter(Boolean)
    .join('\n');
  if (utf8Bytes(output) <= maxBytes) return output || '(no matches)';

  const noticeText = notices.map((notice) => `[${notice}]`).join('\n');
  const separatorBytes = accepted.length > 0 && noticeText ? 1 : 0;
  const finalBodyBudget = Math.max(0, maxBytes - utf8Bytes(noticeText) - separatorBytes);
  return [truncateUtf8(accepted.join('\n'), finalBodyBudget), noticeText]
    .filter(Boolean)
    .join('\n');
}

function retainedGrepLines(result: GrepBackendResult, limit: number, context: number) {
  const retainedMatches = result.lines.filter((item) => item.isMatch).slice(0, limit);
  const matchKeys = new Set(
    retainedMatches.map((item) => `${item.path}\0${item.lineNumber.toString()}`),
  );
  const matchLinesByPath = new Map<string, number[]>();
  for (const item of retainedMatches) {
    const lines = matchLinesByPath.get(item.path) ?? [];
    lines.push(item.lineNumber);
    matchLinesByPath.set(item.path, lines);
  }

  const merged = new Map<string, SearchLine>();
  for (const item of result.lines) {
    const key = `${item.path}\0${item.lineNumber.toString()}`;
    const keep = matchKeys.has(key)
      || (!item.isMatch && context > 0 && (matchLinesByPath.get(item.path) ?? [])
        .some((matchLine) => Math.abs(matchLine - item.lineNumber) <= context));
    if (!keep) continue;
    const existing = merged.get(key);
    merged.set(key, existing
      ? {
          ...existing,
          isMatch: existing.isMatch || item.isMatch,
          backendTruncated: existing.backendTruncated || item.backendTruncated,
        }
      : { ...item, isMatch: matchKeys.has(key) });
  }
  return [...merged.values()];
}

export function formatGrepSearchResult(
  result: GrepBackendResult,
  options: { limit: number; context: number; maxBytes?: number },
) {
  const lines = retainedGrepLines(result, options.limit, options.context);
  if (lines.length === 0) return '(no matches)';

  const truncatedByMatches = result.matchCount > options.limit;
  const notices = truncatedByMatches
    ? [`search truncated at match limit ${options.limit}; narrow path/query/glob or increase limit (max 200)`]
    : [];
  return boundedOutput(
    lines.map(formatSearchLine),
    notices,
    `search truncated at ${options.maxBytes ?? SEARCH_MAX_OUTPUT_BYTES}-byte output limit; narrow path/query/glob or reduce context`,
    options.maxBytes,
  );
}

export function formatGlobSearchResult(
  result: GlobBackendResult,
  options: { limit: number; maxBytes?: number },
) {
  const paths = result.paths.slice(0, options.limit);
  if (paths.length === 0) return '(no matches)';

  const truncatedByCount = result.paths.length > options.limit;
  const notices = truncatedByCount
    ? [`search truncated at result limit ${options.limit}; narrow pattern/path or increase limit (max 200)`]
    : [];
  return boundedOutput(
    paths,
    notices,
    `search truncated at ${options.maxBytes ?? SEARCH_MAX_OUTPUT_BYTES}-byte output limit; narrow pattern/path`,
    options.maxBytes,
  );
}
