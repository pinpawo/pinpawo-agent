import assert from 'node:assert/strict';
import test from 'node:test';
import React, { Children } from 'react';
import { AgentTimeline } from './AgentTimeline';
import {
  buildAgentOperationDisplayLines,
  buildAgentReviewText,
} from './agentTimelineRendering';
import type {
  AgentMessageEntry,
  AgentOperationEntry,
  AgentReviewEntry,
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

test('buildAgentOperationDisplayLines wraps long operation text to the requested width', () => {
  const lines = buildAgentOperationDisplayLines(operationEntry({
    phase: 'started',
    title: 'open',
    target: 'https://example.com/some/really/long/path',
    summary: 'loading dashboard',
  }), 3500, 16);

  assert.ok(lines.length > 1);
  assert.ok(lines.every((line) => line.text.length <= 16));
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

  assert.match(running, /2s/);
  assert.doesNotMatch(running, /失败/);
  assert.match(failed, /失败/);
  assert.match(failed, /找不到元素/);
});

test('buildAgentReviewText renders review status without treating it as a message', () => {
  assert.equal(buildAgentReviewText(reviewEntry('waiting')), '等待你的决定');
  assert.equal(buildAgentReviewText(reviewEntry('answered')), '确认已提交');
  assert.equal(buildAgentReviewText(reviewEntry('interrupted')), '确认已中断');
});

test('AgentTimeline preserves assistant and operation entry order', () => {
  const entries: AgentTimelineEntry[] = [
    messageEntry('assistant-before-tool', '正在打开页面'),
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
    'req-1:operation:open',
    'assistant-after-tool',
  ]);
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

function reviewEntry(status: AgentReviewEntry['status']): AgentReviewEntry {
  return {
    id: `req-1:review:${status}`,
    type: 'review',
    requestId: 'req-1',
    reviewId: 'review-1',
    status,
  };
}
