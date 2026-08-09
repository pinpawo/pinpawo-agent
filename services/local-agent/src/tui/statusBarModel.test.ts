import assert from 'node:assert/strict';
import test from 'node:test';
import { GLOBAL_REVIEW_POLICY_MODE } from '@pinpawo/pet-agent';
import stringWidth from 'string-width';
import {
  buildStatusBarModel,
  formatStatusBarLines,
  formatStatusBarText,
} from './statusBarModel';
import { createSession } from './state/tuiState';

test('buildStatusBarModel separates current state from session resource facts', () => {
  const session = createSession({ id: 'chat:pet', kind: 'chat' });
  session.runtime = {
    model: 'gpt-test',
    cwd: '/Users/mac/project',
    contextWindow: 128000,
  };
  session.sessionTokenUsage = {
    inputTokens: 1000,
    outputTokens: 500,
    totalTokens: 1500,
    latestInputTokens: 800,
    scope: 'session',
  };

  const model = buildStatusBarModel({
    connectionStatus: '就绪',
    session,
    globalReviewPolicyMode: GLOBAL_REVIEW_POLICY_MODE.REQUIRE_AUTHORIZATION,
  });

  assert.deepEqual(model.lines.map((line) => [line.id, line.muted]), [
    ['primary', false],
    ['session', true],
  ]);
  assert.deepEqual(segmentFacts(model, 'primary'), [
    ['connection', undefined, '就绪', 100],
    ['policy', '授权', '需要授权', 80],
  ]);
  assert.deepEqual(segmentFacts(model, 'session'), [
    ['tokens', 'Token', 'in/out 1,000/500 · compact余95,200', 100],
    ['model', '模型', 'gpt-test', 90],
    ['cwd', '目录', '/Users/mac/project', 70],
  ]);
});

test('two-line status keeps token usage visible independently from primary activity', () => {
  const session = createSession({ id: 'chat:pet' });
  session.runtime = {
    model: 'gpt-5.6-sol',
    cwd: '/Users/mac/Develop/pinpawo-agent',
    contextWindow: 128000,
  };
  session.sessionTokenUsage = {
    inputTokens: 20000,
    outputTokens: 3000,
    totalTokens: 23000,
    latestInputTokens: 20000,
    scope: 'session',
  };
  const model = buildStatusBarModel({
    activityStatus: '正在调用能力或工具 · 12s',
    connectionStatus: '连接断开，10s 后重连 1/5',
    session,
    globalReviewPolicyMode: GLOBAL_REVIEW_POLICY_MODE.REQUIRE_AUTHORIZATION,
  });

  const lines = textLines(model, 80);
  assert.equal(lines.length, 2);
  assert.match(lines[0] ?? '', /^正在调用能力或工具 · 12s · 连接:连接断开/);
  assert.match(lines[1] ?? '', /^Token:in\/out 20,000\/3,000 · compact余76,000/);
  assert.ok(lines[1]?.includes('模型:gpt-5.6-sol'));
  assertDisplayWidthAtMost(lines[0] ?? '', 80);
  assertDisplayWidthAtMost(lines[1] ?? '', 80);
});

test('status consumes session cumulative usage instead of the latest run snapshot', () => {
  const session = createSession({ id: 'chat:pet' });
  session.runtime = { model: 'gpt-test', cwd: '/repo', contextWindow: 128000 };
  session.tokenUsage = {
    inputTokens: 9000,
    outputTokens: 1200,
    totalTokens: 10200,
    source: 'provider',
    scope: 'run',
  };
  session.sessionTokenUsage = {
    inputTokens: 29000,
    outputTokens: 4200,
    totalTokens: 33200,
    latestInputTokens: 30000,
    source: 'provider',
    scope: 'session',
  };

  const model = buildStatusBarModel({
    connectionStatus: '就绪',
    session,
    globalReviewPolicyMode: GLOBAL_REVIEW_POLICY_MODE.AUTO_AUTHORIZATION,
  });

  const tokenValue = line(model, 'session').segments.find((segment) => segment.id === 'tokens')?.value;
  assert.equal(tokenValue, 'in/out 29,000/4,200 · compact余66,000');
  assert.equal(tokenValue?.includes('128,000'), false);
});

test('status shows an explicit empty token state before the first completed turn', () => {
  const session = createSession({ id: 'chat:pet' });
  session.runtime = { contextWindow: 64000 };
  const model = buildStatusBarModel({
    connectionStatus: '初始化中',
    session,
    globalReviewPolicyMode: GLOBAL_REVIEW_POLICY_MODE.REQUIRE_AUTHORIZATION,
  });

  assert.equal(
    line(model, 'session').segments.find((segment) => segment.id === 'tokens')?.value,
    '暂无 · 上限64,000',
  );
});

test('status follows reducer-owned composer target and includes the active overlay', () => {
  const model = buildStatusBarModel({
    connectionStatus: '就绪',
    session: createSession({ id: 'chat:pet', kind: 'chat' }),
    globalReviewPolicyMode: GLOBAL_REVIEW_POLICY_MODE.AUTO_AUTHORIZATION,
    overlayOwner: 'Approval',
  });

  assert.deepEqual(
    line(model, 'primary').segments.map((segment) => [segment.id, segment.value]),
    [
      ['connection', '就绪'],
      ['overlay', 'Approval'],
      ['policy', '自动授权'],
    ],
  );
});

test('status notices and connection remain separate on the primary line', () => {
  const model = buildStatusBarModel({
    statusNotice: '出错，已恢复输入',
    connectionStatus: '就绪',
    session: createSession({ id: 'chat:pet' }),
    globalReviewPolicyMode: GLOBAL_REVIEW_POLICY_MODE.REQUIRE_AUTHORIZATION,
  });

  assert.deepEqual(
    line(model, 'primary').segments.slice(0, 2).map((segment) => [segment.id, segment.label, segment.value]),
    [
      ['notice', undefined, '出错，已恢复输入'],
      ['connection', '连接', '就绪'],
    ],
  );
  assert.match(textLines(model, 80)[0] ?? '', /^出错，已恢复输入 · 连接:就绪/);
});

test('formatted lines preserve semantic tones and mute the session line', () => {
  const model = buildStatusBarModel({
    activityStatus: '正在思考 · 2s',
    connectionStatus: '未连接',
    session: createSession({ id: 'chat:pet' }),
    globalReviewPolicyMode: GLOBAL_REVIEW_POLICY_MODE.REQUIRE_AUTHORIZATION,
  });

  const lines = formatStatusBarLines(model, 80);
  assert.equal(lines[0]?.muted, false);
  assert.equal(lines[1]?.muted, true);
  assert.deepEqual(
    lines[0]?.parts
      .filter((part) => !part.separator)
      .slice(0, 3)
      .map((part) => [part.segmentId, part.tone]),
    [
      ['activity', 'warning'],
      ['connection', 'danger'],
      ['policy', 'muted'],
    ],
  );
});

test('retrying and failed connection states keep distinct tones', () => {
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
      session: createSession({ id: 'chat:pet' }),
      globalReviewPolicyMode: GLOBAL_REVIEW_POLICY_MODE.REQUIRE_AUTHORIZATION,
    });
    const connection = formatStatusBarLines(model, 80)[0]?.parts
      .find((part) => part.segmentId === 'connection');
    assert.equal(connection?.tone, expectedTone, connectionStatus);
  }
});

test('both status lines stay within narrow and wide CJK terminal widths', () => {
  const session = createSession({ id: 'chat:pet' });
  session.runtime = {
    model: 'gpt-非常长的模型名称-2026-预览版',
    cwd: '/Users/mac/开发/碰碰我/含中文目录/工作区',
    contextWindow: 128000,
  };
  session.sessionTokenUsage = {
    inputTokens: 20000,
    outputTokens: 3000,
    totalTokens: 23000,
    latestInputTokens: 23000,
    scope: 'session',
  };
  const model = buildStatusBarModel({
    activityStatus: '正在调用能力或工具 · 12s',
    connectionStatus: '连接断开，10s 后重连 1/5',
    session,
    globalReviewPolicyMode: GLOBAL_REVIEW_POLICY_MODE.REQUIRE_AUTHORIZATION,
    overlayOwner: 'Approval',
  });

  for (const width of [32, 80, 120]) {
    const lines = textLines(model, width);
    assert.equal(lines.length, 2);
    for (const text of lines) assertDisplayWidthAtMost(text, width);
    assert.ok(lines[1]?.startsWith('Token:'), `token usage missing at width ${width}`);
  }
  assert.equal(textLines(model, 32)[1], 'Token:20,000/3,000 · C余73,000');
});

function line(model: ReturnType<typeof buildStatusBarModel>, id: 'primary' | 'session') {
  const result = model.lines.find((candidate) => candidate.id === id);
  if (!result) assert.fail(`missing ${id} status line`);
  return result;
}

function segmentFacts(model: ReturnType<typeof buildStatusBarModel>, id: 'primary' | 'session') {
  return line(model, id).segments.map((segment) => [
    segment.id,
    segment.label,
    segment.value,
    segment.priority,
  ]);
}

function textLines(model: ReturnType<typeof buildStatusBarModel>, width: number) {
  return formatStatusBarText(model, width).split('\n');
}

function assertDisplayWidthAtMost(text: string, width: number) {
  assert.ok(
    stringWidth(text) <= width,
    `expected display width <= ${width}, got ${stringWidth(text)} for ${text}`,
  );
}
