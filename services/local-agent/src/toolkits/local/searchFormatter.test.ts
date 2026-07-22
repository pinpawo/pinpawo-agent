import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatGlobSearchResult,
  formatGrepSearchResult,
  SEARCH_MAX_OUTPUT_BYTES,
} from './searchFormatter';

test('grep formatter merges overlapping context blocks', () => {
  const output = formatGrepSearchResult({
    matchCount: 2,
    stoppedAtMatchLimit: false,
    lines: [
      { path: 'src/a.ts', lineNumber: 1, line: 'before', isMatch: false, backendTruncated: false },
      { path: 'src/a.ts', lineNumber: 2, line: 'needle one', isMatch: true, backendTruncated: false },
      { path: 'src/a.ts', lineNumber: 3, line: 'shared', isMatch: false, backendTruncated: false },
      { path: 'src/a.ts', lineNumber: 3, line: 'shared', isMatch: false, backendTruncated: false },
      { path: 'src/a.ts', lineNumber: 4, line: 'needle two', isMatch: true, backendTruncated: false },
      { path: 'src/a.ts', lineNumber: 5, line: 'after', isMatch: false, backendTruncated: false },
    ],
  }, { limit: 10, context: 1 });

  assert.equal((output.match(/^src\/a\.ts-3-/gm) ?? []).length, 1);
  assert.match(output, /^src\/a\.ts:2:/m);
  assert.match(output, /^src\/a\.ts:4:/m);
});

test('grep formatter bounds long lines and total UTF-8 bytes', () => {
  const lines = Array.from({ length: 100 }, (_, index) => ({
    path: `src/${index}.ts`,
    lineNumber: 1,
    line: '界'.repeat(3_000),
    isMatch: true,
    backendTruncated: true,
  }));
  const output = formatGrepSearchResult({
    lines,
    matchCount: lines.length,
    stoppedAtMatchLimit: false,
  }, { limit: 100, context: 0 });

  assert.ok(Buffer.byteLength(output, 'utf-8') <= SEARCH_MAX_OUTPUT_BYTES);
  assert.match(output, /line truncated; use view_file_chunk/);
  assert.match(output, /50000-byte output limit/);
});

test('glob formatter reports count truncation without exceeding byte budget', () => {
  const output = formatGlobSearchResult({
    paths: ['a.ts', 'b.ts'],
    stoppedAtResultLimit: true,
  }, { limit: 1 });

  assert.equal(output, [
    'a.ts',
    '[search truncated at result limit 1; narrow pattern/path or increase limit (max 200)]',
  ].join('\n'));
  assert.ok(Buffer.byteLength(output, 'utf-8') <= SEARCH_MAX_OUTPUT_BYTES);
});
