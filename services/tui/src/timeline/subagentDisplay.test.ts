import assert from 'node:assert/strict';
import test from 'node:test';
import { formatSubagentMessage } from './subagentDisplay';

test('subagent display normalizes spacing while preserving paragraphs', () => {
  assert.equal(
    formatSubagentMessage('  first   sentence。\n\n\nsecond\tparagraph。  '),
    'first sentence。\n\nsecond paragraph。',
  );
  assert.equal(formatSubagentMessage(' \n\t '), null);
});

test('subagent display splits long sentence groups at stable boundaries', () => {
  const first = `第一句${'很长'.repeat(18)}。`;
  const second = `第二句${'继续'.repeat(18)}。`;
  assert.equal(
    formatSubagentMessage(`${first}${second}`),
    `${first}\n${second}`,
  );
});
