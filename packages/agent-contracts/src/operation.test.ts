import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isOperationSummary,
  operationBlockToText,
  isKnownOperationBlock,
  operationSummaryToText,
} from './index';

test('operation summary checks known block kinds field by field', () => {
  assert.equal(isOperationSummary({}), true);
  assert.equal(isOperationSummary({
    summary: 'npm test',
    target: '/repo',
    blocks: [
      { kind: 'code', text: 'npm test', language: 'shell' },
      { kind: 'diff', format: 'unified', text: '@@ -1 +1 @@\n-a\n+b', path: 'a.ts', truncated: true },
      { kind: 'text', text: 'hello', label: '写入内容' },
    ],
  }), true);
  assert.equal(isOperationSummary({ blocks: [{ kind: 'code' }] }), false, 'text is required');
  assert.equal(isOperationSummary({ blocks: [{ kind: 'code', text: 'x', path: 'a' }] }), false, 'no foreign fields');
  assert.equal(isOperationSummary({ blocks: [{ kind: 'text', text: 'x', label: 1 }] }), false);
  assert.equal(isOperationSummary({ blocks: [{ kind: 'diff', format: 'unified', text: 'x', truncated: false }] }), false);
  assert.equal(isOperationSummary({ blocks: [{ kind: 'diff', text: 'x' }] }), false, 'diff declares its format');
  assert.equal(isOperationSummary({ blocks: [{ kind: 'diff', format: 'git', text: 'x' }] }), false);
  assert.equal(isOperationSummary({ details: {} }), false);
  assert.equal(isOperationSummary({ summary: 1 }), false);
});

test('a kind from a newer peer passes with its text and renders as that text', () => {
  const newer = { kind: 'table', text: 'a | b', rows: [['a', 'b']] };
  assert.equal(isOperationSummary({ blocks: [newer] }), true);
  assert.equal(isOperationSummary({ blocks: [{ kind: 'table', rows: [] }] }), false, 'text is required');
  assert.equal(isOperationSummary({ blocks: [{ kind: 'table', text: 'x', rows: () => [] }] }), false, 'fields must be JSON');
  assert.equal(isOperationSummary({ blocks: [{ kind: 'table', text: 'x', truncated: false }] }), false);
  assert.equal(operationBlockToText(newer), 'a | b');
  assert.equal(operationBlockToText({ ...newer, truncated: true }), 'a | b\n…（内容已截断）');
  assert.equal(isKnownOperationBlock(newer), false);
  assert.equal(isKnownOperationBlock({ kind: 'code', text: 'x' }), true);
});

test('default text rendering covers every known kind', () => {
  assert.equal(operationBlockToText({ kind: 'code', text: 'ls', language: 'shell' }), '```shell\nls\n```');
  assert.equal(operationBlockToText({ kind: 'diff', format: 'v4a', text: '-a\n+b' }), '```diff\n-a\n+b\n```');
  assert.equal(operationBlockToText({ kind: 'text', text: 'body', label: '描述' }), '描述:\nbody');
  assert.equal(operationBlockToText({ kind: 'text', text: 'body', truncated: true }), 'body\n…（内容已截断）');
  assert.equal(operationSummaryToText({
    summary: 'ls',
    target: '/repo',
    blocks: [{ kind: 'text', text: 'body' }],
  }), 'Summary: ls\n\nTarget: /repo\n\nbody');
});
