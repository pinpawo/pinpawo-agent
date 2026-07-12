import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTuiScreenModel } from './screenModel';
import {
  createInitialTuiState,
  createSession,
  type TuiState,
} from './state/tuiState';
import type { AgentTimelineEntry } from './timeline/agentTimeline';

test('buildTuiScreenModel exposes explicit layout regions', () => {
  const state = createInitialTuiState(createSession({
    id: 'chat:pet',
    actor: { label: '豆包' },
    timeline: [
      message('m1', 'user', 'hello', 'completed'),
      message('m2', 'assistant', 'typing', 'streaming'),
    ],
  }));
  state.connection = { status: 'ready', message: '就绪' };

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
  assert.equal(model.regions.statusBar.connectionStatus, '就绪');
  assert.equal(model.regions.timeline.renderKey, '3');
  assert.equal(model.regions.timeline.staticBoundaryKey, 'm1');
  assert.equal(model.regions.timeline.scrollStrategy, 'preserveStaticOutputUntilHostReset');
  assert.deepEqual(model.regions.timeline.staticEntries.map((entry) => entry.id), ['m1']);
  assert.deepEqual(model.regions.timeline.dynamicEntries.map((entry) => entry.id), ['m2']);
});

test('buildTuiScreenModel marks composer and status state while busy', () => {
  const state = createInitialTuiState(createSession({ id: 'chat:pet' }));
  state.connection = { status: 'ready', message: '正在思考' };
  state.runs.run1 = {
    requestId: 'run1',
    sessionId: 'chat:pet',
    kind: 'chat',
    phase: 'thinking',
    timelineEntryIds: [],
    startedAt: 0,
    charCount: 0,
  };
  state.sessions['chat:pet'].activeRunId = 'run1';

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
  assert.equal(model.regions.statusBar.connectionStatus, '就绪');
});

test('buildTuiScreenModel preserves recovered ready connection messages', () => {
  const state = createInitialTuiState(createSession({ id: 'chat:pet' }));
  state.connection = { status: 'ready', message: '出错，已恢复输入' };

  const model = buildTuiScreenModel({
    state,
    terminalColumns: 80,
    now: 2500,
    animationFrame: 0,
    timelineRenderEpoch: 0,
  });

  assert.equal(model.regions.statusBar.activityStatus, null);
  assert.equal(model.regions.statusBar.connectionStatus, '出错，已恢复输入');
});

test('buildTuiScreenModel keeps approval status visible while composer accepts reply text', () => {
  const state = createInitialTuiState(createSession({ id: 'chat:pet' }));
  state.connection = { status: 'ready', message: '等待你的决定(pet-1)' };
  const review = {
    id: 'review-1',
    schemaVersion: 1,
    view: { kind: 'plain' as const, body: 'Need review' },
    options: [],
  };
  state.runs.run1 = {
    requestId: 'run1',
    sessionId: 'chat:pet',
    kind: 'chat',
    phase: 'waiting_human',
    timelineEntryIds: [],
    pendingReview: {
      requestId: 'run1',
      petId: 'pet-1',
      review,
      reviews: [review],
      reviewIndex: 0,
      decisions: [],
    },
    startedAt: 0,
    charCount: 0,
  };
  state.sessions['chat:pet'].activeRunId = 'run1';

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
  assert.deepEqual(
    narrow.regions.timeline.staticEntries.map((entry) => entry.id),
    ['m1', 'notice-1', 'm2'],
  );
  assert.deepEqual(
    narrow.regions.timeline.dynamicEntries.map((entry) => entry.id),
    ['activity-1', 'm3'],
  );
  assert.deepEqual(
    narrow.regions.timeline.dynamicEntries.map((entry) => entry.id),
    wide.regions.timeline.dynamicEntries.map((entry) => entry.id),
  );
});

test('buildTuiScreenModel moves completed entries across the viewport boundary once', () => {
  const state = createInitialTuiState(createSession({
    id: 'chat:pet',
    timeline: [
      message('m1', 'user', 'hello', 'completed'),
      message('m2', 'assistant', 'working', 'streaming'),
    ],
  }));
  const streaming = buildTuiScreenModel({
    state,
    terminalColumns: 80,
    now: 1000,
    animationFrame: 0,
    timelineRenderEpoch: 1,
  });

  state.sessions['chat:pet'].timeline = [
    message('m1', 'user', 'hello', 'completed'),
    message('m2', 'assistant', 'done', 'completed'),
  ];
  const completed = buildTuiScreenModel({
    state,
    terminalColumns: 80,
    now: 1000,
    animationFrame: 0,
    timelineRenderEpoch: 1,
  });

  assert.deepEqual(streaming.regions.timeline.staticEntries.map((entry) => entry.id), ['m1']);
  assert.deepEqual(streaming.regions.timeline.dynamicEntries.map((entry) => entry.id), ['m2']);
  assert.deepEqual(completed.regions.timeline.entries.map((entry) => entry.id), ['m1', 'm2']);
  assert.deepEqual(completed.regions.timeline.staticEntries.map((entry) => entry.id), ['m1', 'm2']);
  assert.deepEqual(completed.regions.timeline.dynamicEntries.map((entry) => entry.id), []);
  assert.equal(completed.regions.timeline.staticBoundaryKey, 'm1\u001Fm2');
});

test('buildTuiScreenModel keeps operation viewport boundary stable across completion', () => {
  const state = createInitialTuiState(createSession({
    id: 'chat:pet',
    timeline: [
      message('m1', 'user', 'hello', 'completed'),
      operation('op1', 'started'),
    ],
  }));
  const running = buildTuiScreenModel({
    state,
    terminalColumns: 80,
    now: 1000,
    animationFrame: 0,
    timelineRenderEpoch: 1,
  });

  state.sessions['chat:pet'].timeline = [
    message('m1', 'user', 'hello', 'completed'),
    operation('op1', 'completed'),
  ];
  const completed = buildTuiScreenModel({
    state,
    terminalColumns: 80,
    now: 1000,
    animationFrame: 0,
    timelineRenderEpoch: 1,
  });

  assert.deepEqual(running.regions.timeline.entries.map((entry) => entry.id), ['m1', 'op1']);
  assert.deepEqual(running.regions.timeline.staticEntries.map((entry) => entry.id), ['m1']);
  assert.deepEqual(running.regions.timeline.dynamicEntries.map((entry) => entry.id), ['op1']);
  assert.deepEqual(completed.regions.timeline.entries.map((entry) => entry.id), ['m1', 'op1']);
  assert.deepEqual(completed.regions.timeline.staticEntries.map((entry) => entry.id), ['m1', 'op1']);
  assert.deepEqual(completed.regions.timeline.dynamicEntries.map((entry) => entry.id), []);
  assert.equal(completed.regions.timeline.staticBoundaryKey, 'm1\u001Fop1');
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

function operation(
  id: string,
  phase: 'started' | 'completed',
): AgentTimelineEntry {
  return {
    id,
    type: 'operation',
    requestId: 'run1',
    operationKey: id,
    kind: 'tool',
    title: 'Tool',
    phase,
    startedAt: 1000,
    updatedAt: phase === 'completed' ? 2000 : 1000,
    ...(phase === 'completed' ? { completedAt: 2000 } : {}),
  };
}
