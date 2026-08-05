import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTuiScreenModel } from './screenModel';
import {
  createInitialTuiState,
  createSession,
  type TuiState,
} from './state/tuiState';
import type { AgentTimelineEntry } from '@pinpawo/agent-session';

test('buildTuiScreenModel exposes explicit layout regions', () => {
  const state = createInitialTuiState(createSession({
    id: 'chat:pet',
    actor: { label: '豆包' },
    timeline: [
      message('m1', 'user', 'hello', 'completed'),
      message('m2', 'assistant', 'typing', 'streaming'),
    ],
  }));
  state.connection = { status: 'ready' };

  const model = buildTuiScreenModel({
    state,
    terminalColumns: 100,
    now: 1000,
    animationFrame: 0,
    timelineRenderEpoch: 3,
  });

  assert.equal(model.petName, '豆包');
  assert.equal(model.ready, true);
  assert.equal(model.busy, false);
  assert.equal(model.regions.timeline.width, 96);
  assert.equal(model.regions.composer.textAreaWidth, 92);
  assert.equal(model.regions.statusBar.activityStatus, null);
  assert.equal(model.regions.statusBar.statusNotice, null);
  assert.equal(model.regions.statusBar.connectionStatus, '就绪');
  assert.equal(model.regions.timeline.renderKey, '3');
  assert.deepEqual(model.regions.timeline.entries.map((entry) => entry.id), ['m1', 'm2']);
  assert.equal(model.regions.timeline.emptyState, null);
});

test('buildTuiScreenModel owns the timeline welcome empty state', () => {
  const session = createSession({
    id: 'chat:pet',
    actor: { label: '豆包', summary: '本地协作伙伴' },
  });
  session.runtime = {
    model: 'gpt-test',
    cwd: '/Users/mac/project',
  };
  const state = createInitialTuiState(session);
  state.connection = { status: 'ready' };

  const model = buildTuiScreenModel({
    state,
    terminalColumns: 80,
    now: 1000,
    animationFrame: 0,
    timelineRenderEpoch: 0,
  });

  assert.equal(model.regions.timeline.entries.length, 0);
  assert.equal(model.regions.timeline.emptyState?.greeting, '和 豆包 一起完成当前项目里的任务。');
  assert.equal(model.regions.timeline.emptyState?.ready, true);
  assert.match(model.regions.timeline.emptyState?.details[0]?.value ?? '', /^v\d+\.\d+\.\d+/);
  assert.deepEqual(model.regions.timeline.emptyState?.details.slice(1), [
    { label: '模型', value: 'gpt-test' },
    { label: '目录', value: '/Users/mac/project' },
  ]);
});

test('buildTuiScreenModel marks composer and status state while busy', () => {
  const state = createInitialTuiState(createSession({ id: 'chat:pet' }));
  state.connection = { status: 'ready' };
  state.statusNotice = '旧提示';
  state.sessions['chat:pet'].activeRun = {
    requestId: 'run1',
    state: 'running',
    activity: 'thinking',
    startedAt: 0,
  };

  const model = buildTuiScreenModel({
    state,
    terminalColumns: 30,
    now: 2500,
    animationFrame: 1,
    timelineRenderEpoch: 0,
  });

  assert.equal(model.busy, true);
  assert.equal(model.regions.composer.focused, false);
  assert.equal(model.regions.composer.borderColor, 'yellow');
  assert.equal(model.regions.composer.width, 26);
  assert.equal(model.regions.overlay.width, 26);
  assert.match(model.regions.statusBar.activityStatus ?? '', /正在思考|仍在处理中/);
  assert.equal(model.regions.statusBar.statusNotice, null);
  assert.equal(model.regions.statusBar.connectionStatus, '就绪');
});

test('buildTuiScreenModel keeps status notices separate from ready connection state', () => {
  const state = createInitialTuiState(createSession({ id: 'chat:pet' }));
  state.connection = { status: 'ready' };
  state.statusNotice = '出错，已恢复输入';

  const model = buildTuiScreenModel({
    state,
    terminalColumns: 80,
    now: 2500,
    animationFrame: 0,
    timelineRenderEpoch: 0,
  });

  assert.equal(model.regions.statusBar.activityStatus, null);
  assert.equal(model.regions.statusBar.statusNotice, '出错，已恢复输入');
  assert.equal(model.regions.statusBar.connectionStatus, '就绪');
});

test('buildTuiScreenModel renders transport detail only as connection status', () => {
  const state = createInitialTuiState(createSession({ id: 'chat:pet' }));
  state.connection = {
    status: 'connecting',
    detail: '2s 后重试 1/5',
  };

  const model = buildTuiScreenModel({
    state,
    terminalColumns: 80,
    now: 2500,
    animationFrame: 0,
    timelineRenderEpoch: 0,
  });

  assert.equal(model.regions.statusBar.activityStatus, null);
  assert.equal(model.regions.statusBar.statusNotice, null);
  assert.equal(model.regions.statusBar.connectionStatus, '2s 后重试 1/5');
});

test('buildTuiScreenModel keeps approval status visible while composer accepts reply text', () => {
  const state = createInitialTuiState(createSession({ id: 'chat:pet' }));
  state.connection = { status: 'ready' };
  const review = {
    interactionId: 'review-1',
    schemaVersion: 1,
    view: { kind: 'plain' as const, body: 'Need review' },
    options: [],
  };
  state.sessions['chat:pet'].activeRun = {
    requestId: 'run1',
    state: 'waiting_review',
    reviewAction: {
      actionId: 'interrupt-1',
      petId: 'pet-1',
      reviews: [review],
    },
    startedAt: 0,
  };
  state.reviewDrafts['interrupt-1'] = { actionId: 'interrupt-1', decisions: [] };

  const model = buildTuiScreenModel({
    state,
    terminalColumns: 80,
    now: 2500,
    animationFrame: 0,
    timelineRenderEpoch: 0,
  });

  assert.equal(model.busy, false);
  assert.equal(model.pendingApproval?.requestId, 'run1');
  assert.equal(model.regions.composer.focused, true);
  assert.equal(model.regions.composer.borderColor, 'yellow');
  assert.equal(model.regions.composer.marginTop, 0);
  assert.equal(model.regions.statusBar.activityStatus, '等待你的决定(pet-1)');
  assert.equal(model.regions.statusBar.connectionStatus, '就绪');
});

test('buildTuiScreenModel keeps timeline viewport ids stable across resize', () => {
  const state = createInitialTuiState(createSession({
    id: 'chat:pet',
    timeline: [
      message('m1', 'user', 'hello', 'completed'),
      message('notice-1', 'system', 'after m1', 'completed'),
      message('m2', 'assistant', 'done', 'completed'),
      message('activity-1', 'subagent', 'delegate', 'streaming'),
      message('m3', 'assistant', 'working', 'streaming'),
    ],
  }));

  const narrow = buildTuiScreenModel({
    state,
    terminalColumns: 40,
    now: 1000,
    animationFrame: 0,
    timelineRenderEpoch: 1,
  });
  const wide = buildTuiScreenModel({
    state,
    terminalColumns: 140,
    now: 1000,
    animationFrame: 0,
    timelineRenderEpoch: 2,
  });

  assert.deepEqual(
    narrow.regions.timeline.entries.map((entry) => entry.id),
    wide.regions.timeline.entries.map((entry) => entry.id),
  );
});

function message(
  id: string,
  role: 'user' | 'assistant' | 'system' | 'subagent',
  text: string,
  status: 'streaming' | 'completed',
): AgentTimelineEntry {
  return {
    id,
    type: 'message',
    role,
    requestId: 'run1',
    text,
    status,
  };
}
