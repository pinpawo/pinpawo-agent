import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { KnowledgeDocument, resolveWikiLink } from '../src/KnowledgeDocument';

const pages = ['PROJECT.md', 'architecture.md', 'guides/setup.md', 'guides/hello world.md'];

test('Wiki links resolve from the current document only to listed pages', () => {
  assert.deepEqual(resolveWikiLink('architecture.md#data', 'PROJECT.md', pages), { path: 'architecture.md', anchor: 'data' });
  assert.deepEqual(resolveWikiLink('../PROJECT.md#%E6%A6%82%E8%A7%88', 'guides/setup.md', pages), { path: 'PROJECT.md', anchor: '概览' });
  assert.deepEqual(resolveWikiLink('hello%20world.md', 'guides/setup.md', pages), { path: 'guides/hello world.md', anchor: '' });
  assert.deepEqual(resolveWikiLink('#part', 'PROJECT.md', pages), { path: 'PROJECT.md', anchor: 'part' });
  for (const href of ['../README.md', '../../etc/passwd.md', '/wiki/PROJECT.md', 'https://example.com', 'javascript:alert(1)', 'missing.md', 'architecture.md?x=1']) {
    assert.equal(resolveWikiLink(href, 'PROJECT.md', pages), null, href);
  }
});

test('Wiki renders Markdown headings, tables and safe links without executing HTML', () => {
  const html = renderToStaticMarkup(<KnowledgeDocument path="PROJECT.md" paths={pages} anchor="" onNavigate={() => {}}
    content={'# 概览\n\n[架构](architecture.md#data)\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))'} />);
  assert.match(html, /<h1 id="概览">概览<\/h1>/);
  assert.match(html, /<a href="architecture.md#data">架构<\/a>/);
  assert.match(html, /<table>/);
  assert.doesNotMatch(html, /<script>|href="javascript:/);
});
