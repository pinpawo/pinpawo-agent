import assert from 'node:assert/strict';
import test from 'node:test';
import { GLOBAL_REVIEW_POLICY_MODE } from '@pinpawo/pet-agent';
import stringWidth from 'string-width';
import {
  buildStatusBarModel,
  formatStatusBarParts,
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
    connectionStatus: '就绪',
    mode: 'studio',
    session,
    globalReviewPolicyMode: GLOBAL_REVIEW_POLICY_MODE.REQUIRE_AUTHORIZATION,
  });

  assert.deepEqual(
    model.segments.map((segment) => [segment.id, segment.label, segment.value, segment.priority]),
    [
      ['connection', undefined, '就绪', 100],
      ['mode', undefined, 'Studio', 90],
      ['policy', '授权', '需要授权', 80],
      ['cwd', '目录', '/Users/mac/project', 60],
      ['model', '模型', 'gpt-test', 50],
      ['context', '上下文', '1,500/128,000 (1.2%)', 40],
    ],
  );
});

test('formatStatusBarText keeps cwd visible at normal widths without displacing higher-priority state', () => {
  const model: StatusBarModel = {
    segments: [
      segment('connection', '连接断开，10s 后重连', 100),
      segment('mode', 'Chat', 90),
      segment('policy', '批准执行', 80, '授权'),
      segment('cwd', '/Users/mac/Develop/pinpawo-agent', 60, '目录'),
      segment('model', 'very-long-model-name', 50, '模型'),
    ],
  };

  const normal = formatStatusBarText(model, 80);
  assert.equal(normal, '连接断开，10s 后重连 · Chat · 授权:批准执行 · 目录:/Users/mac/Develop/pinpawo-a…');
  assert.equal(normal.includes('模型:'), false);
  assertDisplayWidthAtMost(normal, 80);
  assert.equal(formatStatusBarText(model, 32), '连接断开，10s 后重连 · Chat');
  assert.equal(formatStatusBarText(model, 12), '连接断开，1…');
});

test('buildStatusBarModel includes current overlay owner when present', () => {
  const model = buildStatusBarModel({
    connectionStatus: '就绪',
    mode: 'chat',
    session: createSession({ id: 'chat:pet' }),
    globalReviewPolicyMode: GLOBAL_REVIEW_POLICY_MODE.AUTO_AUTHORIZATION,
    overlayOwner: 'Approval',
  });

  assert.deepEqual(
    model.segments.map((segment) => [segment.id, segment.label, segment.value, segment.priority]),
    [
      ['connection', undefined, '就绪', 100],
      ['mode', undefined, 'Chat', 90],
      ['overlay', '浮层', 'Approval', 85],
      ['policy', '授权', '自动授权', 80],
      ['cwd', '目录', '未提供', 60],
      ['model', '模型', '未提供', 50],
      ['context', '上下文', '未提供', 40],
    ],
  );
});

test('buildStatusBarModel includes timeline view mode when present', () => {
  const model = buildStatusBarModel({
    connectionStatus: '就绪',
    mode: 'chat',
    timelineViewMode: 'process',
    session: createSession({ id: 'chat:pet' }),
    globalReviewPolicyMode: GLOBAL_REVIEW_POLICY_MODE.AUTO_AUTHORIZATION,
  });

  const segment = model.segments.find((item) => item.id === 'timeline');
  assert.deepEqual(
    segment && [segment.label, segment.value, segment.priority, segment.tone],
    ['视图', '过程', 88, 'info'],
  );
});

test('buildStatusBarModel follows reducer-owned submit mode over session kind', () => {
  const studioSubmitModel = buildStatusBarModel({
    connectionStatus: '就绪',
    mode: 'studio',
    session: createSession({ id: 'chat:pet', kind: 'chat' }),
    globalReviewPolicyMode: GLOBAL_REVIEW_POLICY_MODE.REQUIRE_AUTHORIZATION,
  });
  const chatSubmitModel = buildStatusBarModel({
    connectionStatus: '就绪',
    mode: 'chat',
    session: createSession({ id: 'chat:pet', kind: 'studio' }),
    globalReviewPolicyMode: GLOBAL_REVIEW_POLICY_MODE.REQUIRE_AUTHORIZATION,
  });

  assert.equal(studioSubmitModel.segments.find((segment) => segment.id === 'mode')?.value, 'Studio');
  assert.equal(chatSubmitModel.segments.find((segment) => segment.id === 'mode')?.value, 'Chat');
});

test('buildStatusBarModel keeps activity and connection as separate segments', () => {
  const model = buildStatusBarModel({
    activityStatus: '正在思考 · 2s',
    connectionStatus: '连接断开，10s 后重连',
    mode: 'chat',
    session: createSession({ id: 'chat:pet' }),
    globalReviewPolicyMode: GLOBAL_REVIEW_POLICY_MODE.REQUIRE_AUTHORIZATION,
  });

  assert.deepEqual(
    model.segments.slice(0, 3).map((segment) => [segment.id, segment.label, segment.value, segment.priority]),
    [
      ['activity', undefined, '正在思考 · 2s', 100],
      ['connection', '连接', '连接断开，10s 后重连', 95],
      ['mode', undefined, 'Chat', 90],
    ],
  );
  const normal = formatStatusBarText(model, 80);
  assert.equal(normal, '正在思考 · 2s · 连接:连接断开，10s 后重连 · Chat · 授权:需要授权 · 目录:未提供');
  assert.equal(normal.includes('模型:'), false);
  assertDisplayWidthAtMost(normal, 80);
  assert.equal(formatStatusBarText(model, 34), '正在思考 · 2s · 连接:连接断开，10…');
});

test('formatStatusBarParts preserves segment tones for rendering', () => {
  const model = buildStatusBarModel({
    activityStatus: '正在思考 · 2s',
    connectionStatus: '未连接',
    mode: 'chat',
    session: createSession({ id: 'chat:pet' }),
    globalReviewPolicyMode: GLOBAL_REVIEW_POLICY_MODE.REQUIRE_AUTHORIZATION,
  });

  const parts = formatStatusBarParts(model, 80);

  assert.equal(parts.map((part) => part.text).join(''), formatStatusBarText(model, 80));
  assert.deepEqual(
    parts
      .filter((part) => !part.separator)
      .slice(0, 3)
      .map((part) => [part.segmentId, part.tone]),
    [
      ['activity', 'warning'],
      ['connection', 'danger'],
      ['mode', 'muted'],
    ],
  );
  assert.ok(parts.filter((part) => part.separator).every((part) => part.tone === 'muted'));

  const narrowParts = formatStatusBarParts(model, 7);
  assert.equal(narrowParts.map((part) => part.text).join(''), formatStatusBarText(model, 7));
  assert.equal(narrowParts.at(-1)?.tone, 'warning');
});

test('formatStatusBarParts distinguishes retrying and failed connection tones', () => {
  const cases = [
    ['连接断开，10s 后重连 1/5', 'warning'],
    ['本地服务暂不可用，5s 后重试 2/5', 'warning'],
    ['连接断开，重连失败', 'danger'],
    ['初始化失败：bad config', 'danger'],
    ['未连接', 'danger'],
  ] as const;

  for (const [connectionStatus, expectedTone] of cases) {
    const model = buildStatusBarModel({
      connectionStatus,
      mode: 'chat',
      session: createSession({ id: 'chat:pet' }),
      globalReviewPolicyMode: GLOBAL_REVIEW_POLICY_MODE.REQUIRE_AUTHORIZATION,
    });

    assert.equal(
      formatStatusBarParts(model, 80).find((part) => part.segmentId === 'connection')?.tone,
      expectedTone,
      connectionStatus,
    );
  }
});

test('formatStatusBarText truncates by display width for CJK text', () => {
  const model: StatusBarModel = {
    segments: [
      segment('activity', '正在思考', 100),
      segment('mode', 'Studio', 90),
      segment('cwd', '/tmp/含中文目录/工作区', 20, '目录'),
    ],
  };

  assert.equal(formatStatusBarText(model, 18), '正在思考 · Studio');
  assert.equal(formatStatusBarText(model, 7), '正在思…');
});

test('formatStatusBarText stays within 80 and 120 columns with CJK cwd', () => {
  const activeSession = createSession({ id: 'chat:pet' });
  activeSession.runtime = {
    model: 'gpt-非常长的模型名称-2026-预览版',
    cwd: '/Users/mac/开发/碰碰我/含中文目录/工作区',
    contextWindow: 128000,
  };
  activeSession.tokenUsage = {
    inputTokens: 20000,
    outputTokens: 3000,
    totalTokens: 23000,
  };
  const activeModel = buildStatusBarModel({
    activityStatus: '正在调用能力或工具 · 12s',
    connectionStatus: '连接断开，10s 后重连 1/5',
    mode: 'studio',
    session: activeSession,
    globalReviewPolicyMode: GLOBAL_REVIEW_POLICY_MODE.REQUIRE_AUTHORIZATION,
    overlayOwner: 'Approval',
  });

  for (const width of [80, 120]) {
    assertDisplayWidthAtMost(formatStatusBarText(activeModel, width), width);
  }

  const cwdSession = createSession({ id: 'chat:pet' });
  cwdSession.runtime = {
    model: 'gpt-test',
    cwd: '/Users/mac/开发/碰碰我/含中文目录/工作区',
  };
  const cwdModel = buildStatusBarModel({
    connectionStatus: '就绪',
    mode: 'chat',
    session: cwdSession,
    globalReviewPolicyMode: GLOBAL_REVIEW_POLICY_MODE.REQUIRE_AUTHORIZATION,
  });

  assertDisplayWidthAtMost(formatStatusBarText(cwdModel, 80), 80);
  const wideText = formatStatusBarText(cwdModel, 120);
  assert.ok(wideText.includes('目录:/Users/mac/开发/碰碰我/含中文目录/工作区'));
  assertDisplayWidthAtMost(wideText, 120);
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

function assertDisplayWidthAtMost(text: string, width: number) {
  assert.ok(
    stringWidth(text) <= width,
    `expected display width <= ${width}, got ${stringWidth(text)} for ${text}`,
  );
}
