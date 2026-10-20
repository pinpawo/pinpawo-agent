import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OPERATION_BLOCK_TEXT_LIMIT,
  OPERATION_SUMMARY_TEXT_LIMIT,
  summarizeToolOperation,
} from './operationSummary';

test('summarizeToolOperation parses string arguments and normalizes the summary', () => {
  const summary = summarizeToolOperation({
    summarize: (input) => ({
      target: (input as { cwd: string }).cwd,
      summary: 'npm\n  test',
      blocks: [
        { kind: 'code', text: 'npm\n  test', language: undefined },
        { kind: 'text', text: '' },
      ],
    }),
  }, '{"cwd":"/repo"}');
  assert.deepEqual(summary, {
    target: '/repo',
    summary: 'npm test',
    blocks: [{ kind: 'code', text: 'npm\n  test' }],
  });
});

test('summarizeToolOperation contains throwing, malformed and empty summaries', () => {
  assert.equal(summarizeToolOperation({ summarize: () => { throw new Error('boom'); } }, {}), null);
  assert.equal(summarizeToolOperation({
    summarize: () => ({ details: { a: 1 } }) as never,
  }, {}), null);
  assert.equal(summarizeToolOperation({ summarize: () => ({ summary: '  ' }) }, {}), null);
  assert.equal(summarizeToolOperation(undefined, {}), null);
  assert.equal(summarizeToolOperation({ summarize: () => ({ summary: 'x' }) }, undefined), null);
});

test('summarizeToolOperation caps block text and marks it truncated', () => {
  const summary = summarizeToolOperation({
    summarize: () => ({ blocks: [{ kind: 'diff', format: 'v4a', text: 'x'.repeat(OPERATION_BLOCK_TEXT_LIMIT + 5) }] }),
  }, {});
  assert.equal(summary?.blocks?.[0]?.text.length, OPERATION_BLOCK_TEXT_LIMIT);
  assert.equal(summary?.blocks?.[0]?.truncated, true);
});

test('summarizeToolOperation bounds all blocks together', () => {
  const block = { kind: 'text' as const, text: 'x'.repeat(OPERATION_BLOCK_TEXT_LIMIT) };
  const summary = summarizeToolOperation({ summarize: () => ({ blocks: [block, block, block] }) }, {});
  const blocks = summary?.blocks ?? [];
  assert.equal(blocks.reduce((total, item) => total + item.text.length, 0), OPERATION_SUMMARY_TEXT_LIMIT);
  assert.equal(blocks.length, 2);
  assert.equal(blocks.at(-1)?.truncated, true, 'the dropped block is reported as truncation');
});

test('summarizeToolOperation keeps only the kinds a toolkit may author', () => {
  const summary = summarizeToolOperation({
    summarize: () => ({ summary: 'x', blocks: [{ kind: 'table', text: 'a' }] }) as never,
  }, {});
  assert.deepEqual(summary, { summary: 'x' });
});
