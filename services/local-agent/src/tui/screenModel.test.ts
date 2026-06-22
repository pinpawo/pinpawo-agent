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
  assert.equal(model.regions.statusBar.status, '就绪');
  assert.equal(model.regions.timeline.renderKey, '3');
  assert.equal(model.regions.timeline.staticBoundaryKey, 'm1');
  assert.equal(model.regions.timeline.scrollStrategy, 'preserveStaticOutputUntilHostReset');
  assert.deepEqual(model.regions.timeline.staticEntries.map((entry) => entry.id), ['m1']);
  assert.deepEqual(model.regions.timeline.dynamicEntries.map((entry) => entry.id), ['m2']);
});

test('buildTuiScreenModel marks composer and overlay state while busy', () => {
  const state = createInitialTuiState(createSession({ id: 'chat:pet' }));
  state.connection = { status: 'ready', message: '就绪' };
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
  assert.match(model.regions.overlay.activityStatus, /正在思考|仍在处理中/);
  assert.equal(model.regions.statusBar.status, model.regions.overlay.activityStatus);
});

test('buildTuiScreenModel keeps timeline viewport ids stable across resize', () => {
  const state = createInitialTuiState(createSession({
    id: 'chat:pet',
    timeline: [
      message('m1', 'user', 'hello', 'completed'),
      message('m2', 'assistant', 'done', 'completed'),
      message('m3', 'assistant', 'working', 'streaming'),
    ],
    notices: [
      { id: 'notice-1', text: 'after m1', afterTimelineEntryId: 'm1' },
    ],
    activities: [
      {
        id: 'activity-1',
        type: 'subagent.message',
        requestId: 'run1',
        text: 'delegate',
        status: 'streaming',
        afterTimelineEntryId: 'm2',
      },
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

function message(
  id: string,
  role: 'user' | 'assistant',
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
