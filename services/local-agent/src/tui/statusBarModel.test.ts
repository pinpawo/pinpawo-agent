import assert from 'node:assert/strict';
import test from 'node:test';
import { GLOBAL_REVIEW_POLICY_MODE } from '@pinpawo/pet-agent';
import {
  buildStatusBarModel,
  formatStatusBarText,
  type StatusBarModel,
} from './statusBarModel';
import { createSession } from './state/tuiState';

test('buildStatusBarModel derives explicit prioritized segments', () => {
  const session = createSession({
    id: 'chat:pet',
    kind: 'studio',
  });
  session.runtime = {
    model: 'gpt-test',
    cwd: '/Users/mac/project',
    contextWindow: 128000,
  };
  session.tokenUsage = {
    inputTokens: 1000,
    outputTokens: 500,
    totalTokens: 1500,
  };

  const model = buildStatusBarModel({
    status: '就绪',
    session,
    globalReviewPolicyMode: GLOBAL_REVIEW_POLICY_MODE.REQUIRE_AUTHORIZATION,
  });

  assert.deepEqual(
    model.segments.map((segment) => [segment.id, segment.label, segment.value, segment.priority]),
    [
      ['status', undefined, '就绪', 100],
      ['mode', undefined, 'Studio', 90],
      ['policy', '授权', '需要授权', 80],
      ['model', '模型', 'gpt-test', 50],
      ['context', '上下文', '1,500/128,000 (1.2%)', 40],
      ['cwd', '目录', '/Users/mac/project', 20],
    ],
  );
});

test('formatStatusBarText keeps high-priority segments first under narrow widths', () => {
  const model: StatusBarModel = {
    segments: [
      segment('status', '连接断开，10s 后重连', 100),
      segment('mode', 'Chat', 90),
      segment('policy', '批准执行', 80, '授权'),
      segment('model', 'very-long-model-name', 50, '模型'),
      segment('cwd', '/Users/mac/Develop/pinpawo-agent', 20, '目录'),
    ],
  };

  assert.equal(formatStatusBarText(model, 80), '连接断开，10s 后重连 · Chat · 授权:批准执行 · 模型:very-long-model-name');
  assert.equal(formatStatusBarText(model, 32), '连接断开，10s 后重连 · Chat');
  assert.equal(formatStatusBarText(model, 12), '连接断开，1…');
});

test('formatStatusBarText truncates by display width for CJK text', () => {
  const model: StatusBarModel = {
    segments: [
      segment('status', '正在思考', 100),
      segment('mode', 'Studio', 90),
      segment('cwd', '/tmp/含中文目录/工作区', 20, '目录'),
    ],
  };

  assert.equal(formatStatusBarText(model, 18), '正在思考 · Studio');
  assert.equal(formatStatusBarText(model, 7), '正在思…');
});

function segment(id: string, value: string, priority: number, label?: string) {
  return {
    id,
    value,
    priority,
    ...(label ? { label } : {}),
    truncation: 'truncate' as const,
  };
}
