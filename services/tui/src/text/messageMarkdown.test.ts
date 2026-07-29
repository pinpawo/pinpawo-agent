import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeAssistantMessageMarkdown } from './messageMarkdown';

test('assistant markdown turns tables into terminal-friendly rows', () => {
  assert.equal(
    normalizeAssistantMessageMarkdown([
      '| # | File | Result |',
      '| --- | --- | --- |',
      '| 1 | a.ts | updated |',
      '| 2 | b.ts | skipped |',
    ].join('\n')),
    [
      '1. File: a.ts · Result: updated',
      '2. File: b.ts · Result: skipped',
    ].join('\n'),
  );
});

test('assistant markdown normalizes decorative separators outside code fences', () => {
  assert.equal(
    normalizeAssistantMessageMarkdown([
      'before',
      '',
      '----------',
      'after',
      '```text',
      '----------',
      '```',
    ].join('\n')),
    [
      'before',
      '',
      '. . .',
      'after',
      '```text',
      '----------',
      '```',
    ].join('\n'),
  );
});
