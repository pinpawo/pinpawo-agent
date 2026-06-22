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
  assert.equal(model.regions.timeline.renderEpoch, 3);
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
