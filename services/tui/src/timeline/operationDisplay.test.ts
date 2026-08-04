import assert from 'node:assert/strict';
import test from 'node:test';
import stringWidth from 'string-width';
import type { AgentOperationEntry } from '@pinpawo/agent-session';
import {
  buildOperationDisplayLines,
  OPERATION_OUTPUT_MAX_LINES,
} from './operationDisplay';

test('operation display reuses the legacy toolName(args) header model', () => {
  const lines = buildOperationDisplayLines(operation({
    phase: 'completed',
    title: '打开网页',
    target: 'https://example.com',
    summary: '页面：Example Domain',
    details: { status: 200 },
    operationSource: {
      provider: 'toolkit',
      name: 'browser',
      toolName: '打开网页',
    },
    raw: { output: 'Example Domain loaded' },
  }), 2_500, 120);

  assert.match(lines[0]!.text, /^打开网页\(/);
  assert.match(lines[0]!.text, /status=200/);
  assert.match(lines[0]!.text, /（完成）$/);
  assert.ok(lines.some((line) => (
    line.text.includes('⎿')
    && line.text.includes('Example Domain loaded')
  )));
});

test('operation display bounds output, surfaces errors, and sanitizes controls', () => {
  const completed = buildOperationDisplayLines(operation({
    phase: 'completed',
    raw: {
      output: Array.from(
        { length: 10 },
        (_, index) => `line ${index + 1}`,
      ).join('\n'),
    },
  }), 3_500, 40);
  const failed = buildOperationDisplayLines(operation({
    phase: 'failed',
    raw: { error: 'permission\tdenied\x1B' },
  }), 3_500, 40);

  assert.equal(
    completed.slice(1).length,
    OPERATION_OUTPUT_MAX_LINES + 1,
  );
  assert.match(completed.at(-1)!.text, /… \+4 lines$/);
  assert.ok(failed.some((line) => (
    line.text.includes('permission  denied�')
    && line.tone === 'removed'
  )));
  assert.ok([...completed, ...failed].every((line) => (
    stringWidth(line.text) <= 40
  )));
});

test('operation display exposes bounded apply_patch lines with tones', () => {
  const lines = buildOperationDisplayLines(operation({
    phase: 'completed',
    kind: 'local.apply_patch',
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
    },
  }), 3_500, 80);

  assert.ok(lines.some((line) => (
    line.text === '  -const value = 1;'
    && line.tone === 'removed'
  )));
  assert.ok(lines.some((line) => (
    line.text === '  +const value = 2;'
    && line.tone === 'added'
  )));
  assert.ok(lines.every((line) => stringWidth(line.text) <= 80));
});

test('operation display keeps running and terminal phases distinct', () => {
  const running = buildOperationDisplayLines(operation({
    phase: 'updated',
    startedAt: 1_500,
  }), 3_500, 80)[0]!.text;
  const interrupted = buildOperationDisplayLines(operation({
    phase: 'interrupted',
  }), 3_500, 80)[0]!.text;

  assert.match(running, /进行中 2s/);
  assert.match(interrupted, /已中断/);
});

test('operation display gives runtime authorization and delegation compact activity rows', () => {
  const authorization = buildOperationDisplayLines(operation({
    kind: 'runtime.authorization',
    title: '自动授权 · 2 项操作',
    phase: 'completed',
    details: {
      actions: ['local · which', 'local · version'],
      reason: 'Both checks are read-only.',
    },
  }), 3_500, 100);
  const delegation = buildOperationDisplayLines(operation({
    kind: 'runtime.delegation',
    title: '子任务已交接 · general',
    phase: 'completed',
    summary: 'Check whether coscli is installed.',
    details: { state: 'handed_off' },
  }), 3_500, 100);

  assert.deepEqual(authorization.map((line) => line.text), [
    '自动授权 · 2 项操作（完成）',
    '  local · which · local · version',
    '  原因：Both checks are read-only.',
  ]);
  assert.deepEqual(delegation.map((line) => line.text), [
    '子任务已交接 · general（完成）',
    '  Check whether coscli is installed.',
    '  结果已交给主 agent 汇总',
  ]);
  assert.ok([...authorization, ...delegation].every((line) => stringWidth(line.text) <= 100));
});

function operation(
  overrides: Partial<AgentOperationEntry>,
): AgentOperationEntry {
  return {
    id: 'operation',
    type: 'operation',
    requestId: 'request',
    operationKey: 'operation',
    kind: 'tool',
    title: 'Read file',
    phase: 'started',
    ...overrides,
  };
}
