import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToString } from 'ink';
import { TranscriptViewer } from './TranscriptViewer';

test('TranscriptViewer renders the full projection with navigation help', () => {
  const entries = [
    {
      id: 'user-1',
      type: 'message' as const,
      role: 'user' as const,
      text: 'hello',
      status: 'completed' as const,
    },
    {
      id: 'assistant-1',
      type: 'message' as const,
      role: 'assistant' as const,
      text: 'world',
      status: 'completed' as const,
    },
  ];

  const output = renderToString(
    <TranscriptViewer
      entries={entries}
      petName="Mochi"
      now={0}
      width={76}
      height={20}
      scrollOffset={0}
      contentVersion={entries}
      layoutVersion="test"
      contentHeight={6}
      viewportHeight={12}
      onMetricsChange={() => {}}
    />,
    { columns: 80 },
  );

  assert.match(output, /Transcript\s+Mochi · 2 项 · 全部/);
  assert.match(output, /> hello/);
  assert.match(output, /\| world/);
  assert.match(output, /PgUp\/PgDn 翻页/);
  assert.match(output, /Esc\/q 返回/);
});
