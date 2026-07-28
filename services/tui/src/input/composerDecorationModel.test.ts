import assert from 'node:assert/strict';
import test from 'node:test';
import { buildComposerDecorations } from './composerDecorationModel';

test('composer decorations classify commands, mentions, and Markdown', () => {
  assert.deepEqual(
    buildComposerDecorations('/resume @会话'),
    [{
      line: 0,
      start: 0,
      end: 7,
      tone: 'command',
      priority: 40,
    }, {
      line: 0,
      start: 8,
      end: 13,
      tone: 'mention',
      priority: 25,
    }],
  );

  const decorations = buildComposerDecorations([
    '# 标题 🙂',
    '- **重点** and `code`',
    '[文档](docs/指南.md)',
  ].join('\n'));
  assert.ok(decorations.some((item) => item.tone === 'heading'));
  assert.ok(decorations.some((item) => item.tone === 'marker'));
  assert.ok(decorations.some((item) => item.tone === 'strong'));
  assert.ok(decorations.some((item) => item.tone === 'code'));
  assert.ok(decorations.some((item) => item.tone === 'link'));
  assert.deepEqual(buildComposerDecorations('/Users/mac/file.txt'), []);
  assert.deepEqual(buildComposerDecorations('mail me@example.com'), []);
});

test('composer decoration columns follow terminal cells for CJK and emoji', () => {
  assert.deepEqual(
    buildComposerDecorations('你好🙂 `code`'),
    [{
      line: 0,
      start: 7,
      end: 13,
      tone: 'code',
      priority: 25,
    }],
  );
});

test('composer decorations treat fenced code as one visual region', () => {
  assert.deepEqual(
    buildComposerDecorations([
      '```ts',
      '# not a heading',
      'const value = `raw`;',
      '```',
    ].join('\n')).map(({ line, tone }) => ({ line, tone })),
    [{
      line: 0,
      tone: 'code',
    }, {
      line: 1,
      tone: 'code',
    }, {
      line: 2,
      tone: 'code',
    }, {
      line: 3,
      tone: 'code',
    }],
  );
});

test('composer decorations do not switch fences on another marker', () => {
  assert.deepEqual(
    buildComposerDecorations([
      '```text',
      '~~~',
      '# still code',
      '```',
      '# heading',
    ].join('\n')).map(({ line, tone }) => ({ line, tone })),
    [{
      line: 0,
      tone: 'code',
    }, {
      line: 1,
      tone: 'code',
    }, {
      line: 2,
      tone: 'code',
    }, {
      line: 3,
      tone: 'code',
    }, {
      line: 4,
      tone: 'heading',
    }, {
      line: 4,
      tone: 'marker',
    }],
  );
});

test('composer decorations close only with a compatible fenced-code marker', () => {
  assert.deepEqual(
    buildComposerDecorations([
      '````text',
      '```',
      '````not a closing fence',
      '# still code',
      '````',
      '# heading',
    ].join('\n')).map(({ line, tone }) => ({ line, tone })),
    [{
      line: 0,
      tone: 'code',
    }, {
      line: 1,
      tone: 'code',
    }, {
      line: 2,
      tone: 'code',
    }, {
      line: 3,
      tone: 'code',
    }, {
      line: 4,
      tone: 'code',
    }, {
      line: 5,
      tone: 'heading',
    }, {
      line: 5,
      tone: 'marker',
    }],
  );
});
