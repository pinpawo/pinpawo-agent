import assert from 'node:assert/strict';
import test from 'node:test';
import stringWidth from 'string-width';
import {
  truncateTerminalLine,
  wrapTerminalText,
} from './terminalText';

test('terminal line truncation bounds CJK and neutralizes row-breaking controls', () => {
  const line = truncateTerminalLine('标题\n下一行\t\u001b', 12);
  assert.ok(stringWidth(line) <= 12);
  assert.doesNotMatch(line, /[\n\t\u001b]/);
  assert.match(line, /标题/);
});

test('terminal text wrapping preserves logical lines and wide characters', () => {
  assert.deepEqual(wrapTerminalText('中文AB\nnext', 6), [
    '中文AB',
    'next',
  ]);
});
