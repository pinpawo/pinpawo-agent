import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeAssistantMessageMarkdown } from './tui/render/messageText';

test('normalizeAssistantMessageMarkdown converts markdown tables to terminal-stable rows', () => {
  const text = [
    '### 热门笔记',
    '',
    '| 序号 | 笔记标题 | 作者 | 热度 |',
    '| --- | --- | --- | --- |',
    '| 1 | 一一呀 | 一一呀 | 3.5万 |',
    '| 2 | 爻老板爻一爻完整版 | 丁彰 | 2.4万 |',
  ].join('\n');

  assert.equal(
    normalizeAssistantMessageMarkdown(text),
    [
      '### 热门笔记',
      '',
      '1. 笔记标题: 一一呀 · 作者: 一一呀 · 热度: 3.5万',
      '2. 笔记标题: 爻老板爻一爻完整版 · 作者: 丁彰 · 热度: 2.4万',
    ].join('\n'),
  );
});

test('normalizeAssistantMessageMarkdown shortens decorative separators', () => {
  assert.equal(
    normalizeAssistantMessageMarkdown([
      'before',
      '------------------------------------------------------------------------',
      '',
      '---',
      'after',
    ].join('\n')),
    [
      'before',
      '. . .',
      '',
      '. . .',
      'after',
    ].join('\n'),
  );
});

test('normalizeAssistantMessageMarkdown preserves setext headings', () => {
  const headingWithBlankAfter = [
    'Heading',
    '---',
    '',
    'body',
  ].join('\n');
  const headingWithBodyAfter = [
    'Heading',
    '---',
    'body',
  ].join('\n');

  assert.equal(normalizeAssistantMessageMarkdown(headingWithBlankAfter), headingWithBlankAfter);
  assert.equal(normalizeAssistantMessageMarkdown(headingWithBodyAfter), headingWithBodyAfter);
});

test('normalizeAssistantMessageMarkdown leaves fenced code blocks unchanged', () => {
  const text = [
    '```md',
    '| a | b |',
    '| --- | --- |',
    '| 1 | 2 |',
    '------------------------------------------------------------------------',
    '```',
  ].join('\n');

  assert.equal(normalizeAssistantMessageMarkdown(text), text);
});
