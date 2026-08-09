import assert from 'node:assert/strict';
import test from 'node:test';
import Markdown from '@inkkit/ink-markdown';
import { Text } from 'ink';
import React, { Children, isValidElement } from 'react';
import stringWidth from 'string-width';
import { AgentOperationItem } from './AgentOperationItem';
import { AgentTimeline } from './AgentTimeline';
import { MessageBlock } from './MessageBlock';
import { SubagentMessageItem } from './SubagentMessageItem';
import { formatMessageTimestamp } from '../render/terminalText';
import {
  buildAgentOperationDisplayLines,
  OPERATION_STATUS_DOT,
} from './agentTimelineRendering';
import type {
  AgentMessageEntry,
  AgentOperationEntry,
  AgentTimelineEntry,
} from '@pinpawo/agent-session';

test('buildAgentOperationDisplayLines renders the header as toolName(args) and shows raw output under ⎿', () => {
  const entry = operationEntry({
    phase: 'completed',
    title: '打开网页',
    target: 'https://example.com',
    summary: '页面：Example Domain',
    details: { status: 200 },
    operationSource: { provider: 'toolkit', name: 'browser', toolName: '打开网页' },
  }) as AgentOperationEntry & { raw: { output: string } };
  entry.raw = { output: 'Example Domain loaded' };

  const lines = buildAgentOperationDisplayLines(entry, 2500, 120);
  const header = lines[0]!.text;

  // Header is `toolName(arg summary)（status）`.
  assert.match(header, /^打开网页\(/);
  assert.match(header, /https:\/\/example\.com/);
  assert.match(header, /页面：Example Domain/);
  assert.match(header, /status=200/);
  assert.match(header, /（完成）$/);
  // Raw output now renders on a trailing ⎿ line.
  assert.ok(lines.some((line) => line.text.includes('⎿') && line.text.includes('Example Domain loaded')));
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

test('buildAgentOperationDisplayLines renders V4A diff and raw tool failure output', () => {
  const lines = buildAgentOperationDisplayLines(operationEntry({
    phase: 'failed',
    kind: 'local.apply_patch',
    title: '应用补丁',
    target: 'src/example.ts',
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
      output: JSON.stringify({
        ok: false,
        code: 'context_not_found',
        message: 'Patch context did not match.',
      }),
    },
  }), 3500, 100);

  assert.ok(lines.some((line) => line.text === '  -const value = 1;' && line.tone === 'removed'));
  assert.ok(lines.some((line) => line.text === '  +const value = 2;' && line.tone === 'added'));
  assert.ok(lines.some((line) => line.text.includes('context_not_found') && line.tone === 'removed'));
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

test('buildAgentOperationDisplayLines renders apply_patch through a parsed file update', () => {
  const lines = buildAgentOperationDisplayLines(operationEntry({
    phase: 'started',
    kind: 'local.apply_patch',
    title: '应用补丁',
    target: 'src/app.ts',
    summary: 'update',
    raw: {
      input: {
        patch: [
          '*** Begin Patch',
          '*** Update File: src/app.ts',
          '@@ function main()',
          ' const before = true;',
          '-return before;',
          '+return fresh;',
          ' const middle = true;',
          '-return middle;',
          '+return final;',
          '*** End of File',
          '*** End Patch',
        ].join('\n'),
      },
    },
  }), 3500, 100);

  assert.ok(lines.some((line) => line.text === '  *** Update File: src/app.ts' && line.tone === 'muted'));
  assert.ok(lines.some((line) => line.text === '  @@ function main()' && line.tone === 'muted'));
  assert.ok(lines.some((line) => line.text === '   const before = true;' && line.tone === 'muted'));
  assert.ok(lines.some((line) => line.text === '  -return before;' && line.tone === 'removed'));
  assert.ok(lines.some((line) => line.text === '  +return fresh;' && line.tone === 'added'));
  assert.ok(lines.some((line) => line.text === '   const middle = true;' && line.tone === 'muted'));
  assert.ok(lines.some((line) => line.text === '  -return middle;' && line.tone === 'removed'));
  assert.ok(lines.some((line) => line.text === '  +return final;' && line.tone === 'added'));
  assert.ok(lines.every((line) => stringWidth(line.text) <= 100));
});

test('buildAgentOperationDisplayLines labels malformed apply_patch as raw patch text', () => {
  const lines = buildAgentOperationDisplayLines(operationEntry({
    phase: 'interrupted',
    kind: 'local.apply_patch',
    title: '应用补丁',
    target: '/tmp/example.py',
    summary: 'update',
    raw: {
      input: {
        patch: [
          '*** Begin Patch',
          '*** Update File: /tmp/example.py',
          '@dataclass(frozen=True)',
          ' class AppConfig:',
          '*** End Patch',
        ].join('\n'),
      },
    },
  }), 3500, 100);

  assert.ok(lines.some((line) => line.text === '  patch /tmp/example.py (raw; parse failed)' && line.tone === 'muted'));
  assert.ok(lines.some((line) => line.text === '  *** Update File: /tmp/example.py' && line.tone === 'muted'));
  assert.ok(lines.some((line) => line.text === '  @dataclass(frozen=True)' && line.tone === 'muted'));
  assert.ok(lines.every((line) => stringWidth(line.text) <= 100));
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

  // Header reads `toolLabel(args…)（status）`; without a source, the label
  // falls back to the operation title.
  assert.equal(
    running,
    '点击页面(text=登录 · 点击 text=登录 · selector=text=登录)（开始）',
  );
  assert.match(
    completed,
    /^打开网页\(https:\/\/example\.com\/ · 页面：Example Domain · title=Example Domain · url=https:\/\/example\.com\/\)（完成）$/,
  );
  assert.match(
    failed,
    /^等待页面\(#result · No active browser page\. Use browser_open first\. · selector=#result · timeoutMs=5000\)（失败）$/,
  );
});

test('buildAgentOperationDisplayLines collapses long output and surfaces errors', () => {
  const longOutput = Array.from({ length: 10 }, (_, i) => `line ${(i + 1).toString()}`).join('\n');
  const completed = buildAgentOperationDisplayLines({
    ...operationEntry({ phase: 'completed', title: 'run_shell', summary: 'ls' }),
    raw: { output: longOutput },
  }, 3500, 120);
  const failed = buildAgentOperationDisplayLines({
    ...operationEntry({ phase: 'failed', title: 'run_shell', summary: 'cat missing' }),
    raw: { error: 'No such file or directory' },
  }, 3500, 120);

  const outputLines = completed.filter((line) => line.id.includes(':output:'));
  // Capped at OPERATION_OUTPUT_MAX_LINES (6) plus a "+N lines" footer.
  assert.equal(outputLines.length, 7);
  assert.match(outputLines[0]!.text, /⎿ line 1$/);
  assert.match(outputLines.at(-1)!.text, /… \+4 lines$/);
  assert.ok(outputLines.slice(0, -1).every((line) => line.tone === 'muted'));

  const failedOutput = failed.filter((line) => line.id.includes(':output:'));
  assert.ok(failedOutput.some((line) =>
    line.text.includes('No such file or directory') && line.tone === 'removed'));
});

test('buildAgentOperationDisplayLines uses operationSource.toolName for the header label', () => {
  const lines = buildAgentOperationDisplayLines(operationEntry({
    phase: 'completed',
    kind: 'local.apply_patch',
    title: '应用补丁',
    target: 'src/app.ts',
    operationSource: { provider: 'toolkit', name: 'apply_patch', toolName: 'apply_patch' },
  }), 3500, 120);

  assert.match(lines[0]!.text, /^apply_patch\(src\/app\.ts\)（完成）$/);
});

test('buildAgentOperationDisplayLines tags the header line with the phase for the status dot', () => {
  const completed = buildAgentOperationDisplayLines(operationEntry({ phase: 'completed' }), 3500, 120);
  const failed = buildAgentOperationDisplayLines(operationEntry({ phase: 'failed' }), 3500, 120);

  assert.equal(completed[0]!.statusDot, 'completed');
  assert.equal(failed[0]!.statusDot, 'failed');
  // Only the header line carries a status dot.
  assert.ok(completed.slice(1).every((line) => line.statusDot === undefined));
});

test('AgentOperationItem renders a phase-colored status dot before the header', () => {
  const dotFor = (phase: AgentOperationEntry['phase']) => {
    const element = AgentOperationItem({
      entry: operationEntry({ phase }),
      now: 3000,
      width: 120,
    });
    const dot = findElementsByType(element, Text)
      .find((node) => node.props.children === OPERATION_STATUS_DOT);
    return dot?.props;
  };

  assert.equal(dotFor('completed')?.color, 'green');
  assert.equal(dotFor('failed')?.color, 'red');
  assert.equal(dotFor('interrupted')?.color, 'yellow');
  // Running/pending uses a dim (gray) dot with no explicit color.
  assert.equal(dotFor('started')?.color, undefined);
  assert.equal(dotFor('started')?.dimColor, true);
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

test('MessageBlock renders user messages in green', () => {
  const createdAt = '2026-07-15T02:00:00.000Z';
  const element = MessageBlock({
    entry: {
      role: 'user',
      createdAt,
      text: '请更新 timeline 颜色',
    },
    petName: '小派',
    width: 80,
  });

  const textNodes = findElementsByType(element, Text);

  assert.ok(textNodes.some((node) =>
    node.props.children === `[${formatMessageTimestamp(createdAt)}] 你`
      && node.props.color === 'green'
  ));
  assert.ok(textNodes.some((node) =>
    node.props.children === '> ' && node.props.color === 'green' && node.props.dimColor
  ));
  assert.ok(textNodes.some((node) =>
    node.props.children === '请更新 timeline 颜色' && node.props.color === 'green'
  ));
});

test('MessageBlock renders assistant content through markdown', () => {
  const element = MessageBlock({
    entry: {
      role: 'assistant',
      text: '| A | B |\n| - | - |\n| **one** | `two` |',
    },
    petName: '小派',
    width: 80,
  });

  const markdown = findElementByType(element, Markdown);

  assert.ok(markdown);
  assert.equal(markdown.props.children, '| A | B |\n| - | - |\n| **one** | `two` |');
  const markdownProps = markdown.props as {
    children?: React.ReactNode;
    showSectionPrefix?: boolean;
  };
  assert.equal(markdownProps.showSectionPrefix, false);
});

test('checkpoint assistant messages render through markdown', () => {
  const entry = {
    id: 'message:assistant-checkpoint',
    type: 'message',
    role: 'assistant',
    text: '**历史回答**\n\n- 第一项\n- 第二项',
    status: 'completed',
  } satisfies AgentMessageEntry;

  const element = MessageBlock({
    entry,
    petName: '小派',
    width: 80,
  });
  const markdown = findElementByType(element, Markdown);

  assert.ok(markdown);
  assert.equal(markdown.props.children, '**历史回答**\n\n- 第一项\n- 第二项');
});

test('SubagentMessageItem renders a subagent timeline message entry', () => {
  const message = subagentMessage('req-1:subagent-output', '先检查文件');
  message.createdAt = '2026-07-15T02:00:00.000Z';
  const element = SubagentMessageItem({
    entry: message,
    width: 80,
  });

  assert.ok(isValidElement(element));
  assert.ok(findElementsByType(element, Text).some((node) =>
    node.props.children === `[${formatMessageTimestamp(message.createdAt!)}] subagent`
  ));
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

function findElementsByType(
  node: React.ReactNode,
  type: React.ElementType,
): Array<React.ReactElement<Record<string, unknown>>> {
  if (!isValidElement(node)) return [];
  const matches = node.type === type
    ? [node as React.ReactElement<Record<string, unknown>>]
    : [];
  const children = Children.toArray((node.props as { children?: React.ReactNode }).children);
  return [
    ...matches,
    ...children.flatMap((child) => findElementsByType(child, type)),
  ];
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

function subagentMessage(id: string, text: string): AgentMessageEntry {
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
