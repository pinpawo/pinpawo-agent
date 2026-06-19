import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildBusyStatusLine,
  formatStudioProgressEvent,
  formatSubagentMessage,
  formatSystemNoticeEvent,
} from './tui/render/eventText';

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

  assert.equal(
    buildBusyStatusLine(
      { phase: 'thinking', startedAt: 1000, charCount: 0 },
      3500,
      '|',
      [{ name: 'tool-1', label: '读文件', detail: '/tmp/example.md', startedAt: 1000 }],
    ),
    '| 正在思考 · 2s · tool-1',
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
