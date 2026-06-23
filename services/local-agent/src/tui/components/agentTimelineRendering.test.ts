import assert from 'node:assert/strict';
import test from 'node:test';
import Markdown from '@inkkit/ink-markdown';
import React, { Children, isValidElement } from 'react';
import stringWidth from 'string-width';
import { AgentTimeline } from './AgentTimeline';
import { MessageBlock } from './MessageBlock';
import { SubagentActivityItem } from './SubagentActivityItem';
import {
  buildAgentOperationDisplayLines,
} from './agentTimelineRendering';
import {
  agentTimelineEntriesFromSnapshot,
  buildTuiSessionSnapshotFromMessages,
} from '../snapshot/tuiSessionSnapshot';
import type {
  AgentMessageEntry,
  AgentOperationEntry,
  AgentTimelineEntry,
} from '../timeline/agentTimeline';
import type { SessionActivityModel } from '../state/tuiState';

test('buildAgentOperationDisplayLines preserves generic operation text without reading raw payloads', () => {
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

test('buildAgentOperationDisplayLines keeps write_file payloads out of the summary line', () => {
  const lines = buildAgentOperationDisplayLines(operationEntry({
    phase: 'completed',
    kind: 'local.write_file',
    title: '写文件',
    target: 'src/example.ts',
    summary: 'write',
    details: {
      before: 'const value = 1;\nconsole.log(value);\n',
      after: 'const value = 2;\nconsole.log(value);\n',
      mode: 'write',
    },
  }), 3500, 80);

  assert.equal(lines.length, 1);
  assert.match(lines[0]!.text, /mode=write/);
  assert.doesNotMatch(lines[0]!.text, /before=/);
  assert.doesNotMatch(lines[0]!.text, /after=/);
  assert.ok(lines.every((line) => stringWidth(line.text) <= 80));
});

test('buildAgentOperationDisplayLines renders apply_patch raw input on operation lines', () => {
  const lines = buildAgentOperationDisplayLines(operationEntry({
    phase: 'started',
    kind: 'local.apply_patch',
    title: '应用补丁',
    target: 'src/example.ts',
    summary: 'update',
    raw: {
      input: {
        patch: [
          '*** Begin Patch',
          '*** Update File: src/example.ts',
          '@@',
          '-const value = 1;',
          '+const value = 2;',
          '*** End Patch',
        ].join('\n'),
      },
    },
    details: {
      patch: '*** Begin Patch\n*** Update File: truncated.ts\n-details\n+details\n*** End Patch',
    },
  }), 3500, 80);

  assert.match(lines[0]!.text, /update/);
  assert.doesNotMatch(lines[0]!.text, /patch=/);
  assert.ok(lines.some((line) => line.text === '  -const value = 1;' && line.tone === 'removed'));
  assert.ok(lines.some((line) => line.text === '  +const value = 2;' && line.tone === 'added'));
  assert.ok(lines.every((line) => !line.text.includes('details')));
  assert.ok(lines.every((line) => stringWidth(line.text) <= 80));
});

test('buildAgentOperationDisplayLines falls back to apply_patch details without raw input', () => {
  const lines = buildAgentOperationDisplayLines(operationEntry({
    phase: 'started',
    kind: 'local.apply_patch',
    title: '应用补丁',
    target: 'src/example.ts',
    summary: 'update',
    details: {
      patch: [
        '*** Begin Patch',
        '*** Update File: src/example.ts',
        '@@',
        '-const value = 1;',
        '+const value = 2;',
        '*** End Patch',
      ].join('\n'),
    },
  }), 3500, 80);

  assert.match(lines[0]!.text, /update/);
  assert.doesNotMatch(lines[0]!.text, /patch=/);
  assert.ok(lines.some((line) => line.text === '  -const value = 1;' && line.tone === 'removed'));
  assert.ok(lines.some((line) => line.text === '  +const value = 2;' && line.tone === 'added'));
  assert.ok(lines.every((line) => stringWidth(line.text) <= 80));
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

test('MessageBlock renders assistant content through markdown', () => {
  const element = MessageBlock({
    entry: {
      kind: 'assistant',
      text: '| A | B |\n| - | - |\n| **one** | `two` |',
    },
    petName: '小派',
    width: 80,
  });

  const markdown = findElementByType(element, Markdown);

  assert.ok(markdown);
  assert.equal(markdown.props.children, '| A | B |\n| - | - |\n| **one** | `two` |');
});

test('history snapshot assistant messages render through markdown', () => {
  const snapshot = buildTuiSessionSnapshotFromMessages({
    sessionId: 'chat:pet',
    kind: 'chat',
    messages: [
      {
        id: 'assistant-history',
        kind: 'assistant',
        text: '**历史回答**\n\n- 第一项\n- 第二项',
      },
    ],
  });
  const [entry] = agentTimelineEntriesFromSnapshot(snapshot.timeline);
  assert.equal(entry?.type, 'message');
  assert.equal(entry?.type === 'message' ? entry.role : undefined, 'assistant');

  const element = MessageBlock({
    entry: {
      kind: entry.role,
      text: entry.text,
    },
    petName: '小派',
    width: 80,
  });
  const markdown = findElementByType(element, Markdown);

  assert.ok(markdown);
  assert.equal(markdown.props.children, '**历史回答**\n\n- 第一项\n- 第二项');
});

test('SubagentActivityItem renders subagent activity outside timeline entries', () => {
  const activity = subagentActivity('req-1:subagent-output', '先检查文件');
  const element = SubagentActivityItem({
    activity,
    width: 80,
  });

  assert.ok(isValidElement(element));
});

function findElementByType(
  node: React.ReactNode,
  type: React.ElementType,
): React.ReactElement<{ children?: React.ReactNode }> | null {
  if (!isValidElement(node)) return null;
  if (node.type === type) {
    return node as React.ReactElement<{ children?: React.ReactNode }>;
  }

  const children = Children.toArray((node.props as { children?: React.ReactNode }).children);
  for (const child of children) {
    const match = findElementByType(child, type);
    if (match) return match;
  }
  return null;
}

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

function subagentActivity(id: string, text: string): SessionActivityModel {
  return {
    id,
    type: 'subagent.message',
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
