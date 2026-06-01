import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildActiveToolLines,
  buildBusyStatusLine,
  formatOperationDiffPreview,
  formatOperationResult,
  formatOperationStart,
  formatStudioProgressEvent,
  formatSystemNoticeEvent,
  getOperationKey,
} from './tui/render/eventText';
import type { LocalAgentOperationEvent } from './events/localAgentEvent';

test('formats operation events without reading legacy tool input/output', () => {
  const event: LocalAgentOperationEvent = {
    type: 'operation',
    requestId: 'req-1',
    phase: 'started',
    operation: {
      id: 'call-1',
      kind: 'file.read',
      title: '读文件',
      target: '/tmp/example.md',
      source: {
        provider: 'toolkit',
        name: 'read_file',
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
        kind: 'shell.run',
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
        kind: 'shell.run',
        title: '执行命令',
        summary: 'exit 1',
      },
    }),
    '执行命令：失败 · exit 1',
  );
});

test('formats file edit operations with a reviewable diff preview', () => {
  const event: LocalAgentOperationEvent = {
    type: 'operation',
    requestId: 'req-1',
    phase: 'completed',
    operation: {
      kind: 'file.update',
      title: '改文件',
      target: 'src/app.ts',
    },
    raw: {
      input: {
        path: 'src/app.ts',
        find: 'const oldValue = 1;\nexport { oldValue };',
        replace: 'const newValue = 2;\nexport { newValue };',
      },
    },
  };

  const diffPreview = [
    'diff 预览：',
    '```diff',
    '--- src/app.ts',
    '+++ src/app.ts',
    '@@ edit 1 @@',
    '-const oldValue = 1;',
    '-export { oldValue };',
    '+const newValue = 2;',
    '+export { newValue };',
    '```',
  ].join('\n');

  assert.equal(formatOperationDiffPreview(event), diffPreview);
  assert.equal(formatOperationResult(event), `改文件：src/app.ts\n${diffPreview}`);
});

test('formats unified patch operations as diff preview', () => {
  assert.equal(
    formatOperationDiffPreview({
      type: 'operation',
      requestId: 'req-1',
      phase: 'completed',
      operation: {
        kind: 'patch.apply',
        title: '应用 diff',
      },
      raw: {
        input: {
          patch: [
            '--- a/file.txt',
            '+++ b/file.txt',
            '@@ -1 +1 @@',
            '-old',
            '+new',
          ].join('\n'),
        },
      },
    }),
    [
      'diff 预览：',
      '```diff',
      '--- a/file.txt',
      '+++ b/file.txt',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '```',
    ].join('\n'),
  );
});

test('formats shell output when it contains unified diff text', () => {
  assert.equal(
    formatOperationDiffPreview({
      type: 'operation',
      requestId: 'req-1',
      phase: 'completed',
      operation: {
        kind: 'shell.run',
        title: '执行命令',
      },
      raw: {
        output: [
          'some preface',
          'diff --git a/file.txt b/file.txt',
          '--- a/file.txt',
          '+++ b/file.txt',
          '@@ -1 +1 @@',
          '-old',
          '+new',
        ].join('\n'),
      },
    }),
    [
      'diff 预览：',
      '```diff',
      'diff --git a/file.txt b/file.txt',
      '--- a/file.txt',
      '+++ b/file.txt',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '```',
    ].join('\n'),
  );
});

test('formats studio progress events from typed local-agent events', () => {
  assert.equal(
    formatStudioProgressEvent({
      type: 'studio.progress',
      requestId: 'req-1',
      event: {
        type: 'dispatch_started',
        petId: 'planner',
        taskIndex: 2,
      },
    }),
    '[studio] dispatch[#2] → pet:planner',
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
    buildActiveToolLines([
      {
        name: 'tool-1',
        label: '读文件',
        detail: '/tmp/example.md',
        startedAt: 1000,
      },
    ], 3500, 80),
    [{
      id: 'tool-tool-1-0-0',
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
