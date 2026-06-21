import assert from 'node:assert/strict';
import test from 'node:test';
import React, { Children, isValidElement } from 'react';
import stringWidth from 'string-width';
import { AgentTimeline } from './AgentTimeline';
import { AgentTimelineItem } from './AgentTimelineItem';
import { AgentMessageItem } from './AgentMessageItem';
import {
  buildAgentOperationDisplayLines,
} from './agentTimelineRendering';
import type {
  AgentMessageEntry,
  AgentOperationEntry,
  AgentTimelineEntry,
} from '../timeline/agentTimeline';

test('buildAgentOperationDisplayLines preserves operation lifecycle text without reading raw payloads', () => {
  const entry = operationEntry({
    phase: 'completed',
    title: '打开网页',
    target: 'https://example.com',
    summary: '页面：Example Domain',
    details: { status: 200 },
  }) as AgentOperationEntry & { raw: { output: string } };
  entry.raw = { output: 'secret raw browser payload' };

  const text = buildAgentOperationDisplayLines(entry, 2500, 120)
    .map((line) => line.text)
    .join('\n');

  assert.match(text, /打开网页/);
  assert.match(text, /https:\/\/example\.com/);
  assert.match(text, /页面：Example Domain/);
  assert.match(text, /status=200/);
  assert.doesNotMatch(text, /secret raw/);
});

test('buildAgentOperationDisplayLines keeps operation text to one clipped status line', () => {
  const lines = buildAgentOperationDisplayLines(operationEntry({
    phase: 'started',
    title: 'open',
    target: 'https://example.com/some/really/long/path',
    summary: 'loading dashboard',
  }), 3500, 16);

  assert.equal(lines.length, 1);
  assert.ok(stringWidth(lines[0]!.text) <= 16);
  assert.match(lines[0]!.text, /（开始）$/);
});

test('buildAgentOperationDisplayLines keeps running and terminal phases distinct', () => {
  const running = buildAgentOperationDisplayLines(operationEntry({
    phase: 'updated',
    title: '点击页面',
    target: '.login',
  }), 3500, 120).map((line) => line.text).join('\n');
  const failed = buildAgentOperationDisplayLines(operationEntry({
    phase: 'failed',
    title: '点击页面',
    target: '.login',
    summary: '找不到元素',
  }), 3500, 120).map((line) => line.text).join('\n');

  assert.match(running, /进行中 2s/);
  assert.doesNotMatch(running, /失败/);
  assert.match(failed, /失败/);
  assert.match(failed, /找不到元素/);
});

test('buildAgentOperationDisplayLines renders browser active completed and failed states', () => {
  const running = buildAgentOperationDisplayLines(operationEntry({
    phase: 'started',
    title: '点击页面',
    target: 'text=登录',
    summary: '点击 text=登录',
    details: { selector: 'text=登录' },
  }), 3500, 120).map((line) => line.text).join('\n');
  const completed = buildAgentOperationDisplayLines(operationEntry({
    phase: 'completed',
    title: '打开网页',
    target: 'https://example.com/',
    summary: '页面：Example Domain',
    details: { title: 'Example Domain', url: 'https://example.com/' },
  }), 3500, 120).map((line) => line.text).join('\n');
  const failed = buildAgentOperationDisplayLines(operationEntry({
    phase: 'failed',
    title: '等待页面',
    target: '#result',
    summary: 'No active browser page. Use browser_open first.',
    details: { selector: '#result', timeoutMs: 5000 },
  }), 3500, 120).map((line) => line.text).join('\n');

  assert.equal(
    running,
    '点击 text=登录 · text=登录 · selector=text=登录 · 点击页面（开始）',
  );
  assert.match(
    completed,
    /^页面：Example Domain · https:\/\/example\.com\/ · title=Example Domain · url=https:\/\/example\.com\/ · 打开网页（完成）$/,
  );
  assert.match(
    failed,
    /^No active browser page\. Use browser_open first\. · #result · selector=#result · timeoutMs=5000 · 等待页面（失败）$/,
  );
});

test('AgentTimeline preserves assistant and operation entry order', () => {
  const entries: AgentTimelineEntry[] = [
    messageEntry('assistant-before-tool', '正在打开页面'),
    subagentMessageEntry('req-1:subagent-output', '先检查文件'),
    operationEntry({
      id: 'req-1:operation:open',
      operationKey: 'open',
      phase: 'completed',
      title: '打开网页',
    }),
    messageEntry('assistant-after-tool', '页面打开了'),
  ];
  const element = AgentTimeline({
    entries,
    petName: '小派',
    width: 80,
    now: 3000,
  }) as unknown as { props: { children: unknown } };

  const children = Children.toArray(element.props.children as React.ReactNode) as Array<{
    props: { entry: AgentTimelineEntry };
  }>;

  assert.deepEqual(children.map((child) => child.props.entry.id), [
    'assistant-before-tool',
    'req-1:subagent-output',
    'req-1:operation:open',
    'assistant-after-tool',
  ]);
});

test('AgentTimelineItem renders subagent messages through AgentMessageItem', () => {
  const entry = subagentMessageEntry('req-1:subagent-output', '先检查文件');
  const element = AgentTimelineItem({
    entry,
    petName: '小派',
    width: 80,
    now: 3000,
  });

  assert.ok(isValidElement(element));
  assert.equal(element.type, AgentMessageItem);
  assert.deepEqual(element.props, {
    entry,
    petName: '小派',
    width: 80,
  });
});

function operationEntry(params: Partial<AgentOperationEntry>): AgentOperationEntry {
  return {
    id: 'req-1:operation:call-1',
    type: 'operation',
    requestId: 'req-1',
    operationKey: 'call-1',
    kind: 'browser.open',
    title: '打开网页',
    phase: 'started',
    startedAt: 1000,
    updatedAt: 1000,
    ...params,
  };
}

function subagentMessageEntry(id: string, text: string): AgentMessageEntry {
  return {
    id,
    type: 'message',
    role: 'subagent',
    requestId: 'req-1',
    text,
    status: 'streaming',
  };
}

function messageEntry(id: string, text: string): AgentMessageEntry {
  return {
    id,
    type: 'message',
    role: 'assistant',
    requestId: 'req-1',
    text,
    status: 'completed',
  };
}
