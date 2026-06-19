import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildActiveOperationLines,
  buildBusyStatusLine,
  formatOperationResult,
  formatOperationStart,
  formatStudioProgressEvent,
  formatSubagentMessage,
  formatSystemNoticeEvent,
  getOperationKey,
} from './tui/render/eventText';
import type { LocalAgentOperationInternalEvent } from './events/localAgentEvent';

test('formats operation events without reading legacy tool input/output', () => {
  const event: LocalAgentOperationInternalEvent = {
    type: 'operation',
    requestId: 'req-1',
    phase: 'started',
    operation: {
      id: 'call-1',
      kind: 'bash.read_file',
      title: '读文件',
      target: '/tmp/example.md',
      source: {
        provider: 'toolkit',
        name: 'bash',
        toolName: 'read_file',
        callId: 'call-1',
      },
    },
    raw: {
      input: '{"path":"should-not-be-rendered"}',
    },
  };

  assert.equal(getOperationKey(event), 'call-1');
  assert.deepEqual(formatOperationStart(event), {
    label: '读文件',
    detail: '/tmp/example.md',
  });
});

test('formats completed and failed operation summaries from event fields', () => {
  assert.equal(
    formatOperationResult({
      type: 'operation',
      requestId: 'req-1',
      phase: 'completed',
      operation: {
        kind: 'bash.run_shell',
        title: '执行命令',
        summary: 'git status --short',
      },
    }),
    '执行命令：git status --short',
  );

  assert.equal(
    formatOperationResult({
      type: 'operation',
      requestId: 'req-1',
      phase: 'failed',
      operation: {
        kind: 'bash.run_shell',
        title: '执行命令',
        summary: 'exit 1',
      },
    }),
    '执行命令：失败 · exit 1',
  );

  // Completed result keeps the target inherited from the start event.
  assert.equal(
    formatOperationResult({
      type: 'operation',
      requestId: 'req-1',
      phase: 'completed',
      operation: {
        kind: 'bash.view_file_chunk',
        title: '看片段',
        target: 'README.md',
        details: { startLine: 1, endLine: 50 },
      },
    }),
    '看片段：README.md · startLine=1 · endLine=50',
  );

  // Failed result surfaces the target too, not just the error summary.
  assert.equal(
    formatOperationResult({
      type: 'operation',
      requestId: 'req-1',
      phase: 'failed',
      operation: {
        kind: 'browser.browser_open',
        title: '打开网页',
        target: 'https://example.com',
      },
    }),
    '打开网页：失败 · https://example.com',
  );
});

test('formats subagent text into readable paragraphs', () => {
  assert.equal(
    formatSubagentMessage(
      '我先打开页面。现在搜索结果出来了，我会查看第一个帖子。然后继续收集评论。最后汇总。'.repeat(2),
    )?.startsWith('[subagent]\n'),
    true,
  );
  assert.match(
    formatSubagentMessage(
      '我先打开页面。现在搜索结果出来了，我会查看第一个帖子。然后继续收集评论。最后汇总。'.repeat(2),
    ) ?? '',
    /\n.+\n.+/,
  );
});

test('formats studio progress events from typed local-agent events', () => {
  assert.equal(
    formatStudioProgressEvent({
      type: 'studio.progress',
      requestId: 'req-1',
      event: {
        type: 'task_started',
        petId: 'planner',
        taskIndex: 2,
        petRunId: 'pet-run-1',
      },
    }),
    '[studio] task[#2] → pet:planner',
  );
});

test('formats status and active operation lines from render adapter props', () => {
  assert.equal(
    buildBusyStatusLine(
      { phase: 'thinking', startedAt: 1000, charCount: 8 },
      2500,
      '-',
      [],
    ),
    '- 正在思考 · 1s · 8 字',
  );

  assert.deepEqual(
    buildActiveOperationLines([
      {
        name: 'tool-1',
        label: '读文件',
        detail: '/tmp/example.md',
        startedAt: 1000,
      },
    ], 3500, 80),
    [{
      id: 'operation-tool-1-0-0',
      text: '读文件 · 2s · /tmp/example.md',
    }],
  );
});

test('formats system notice events without preserving empty notices', () => {
  assert.equal(
    formatSystemNoticeEvent({
      type: 'system.notice',
      requestId: 'req-1',
      message: '  已切换模型  ',
    }),
    '已切换模型',
  );
  assert.equal(
    formatSystemNoticeEvent({
      type: 'system.notice',
      requestId: 'req-1',
      message: '   ',
    }),
    null,
  );
});
