import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentRunView } from '@pinpawo/agent-session';
import {
  LiveActivityController,
  LOADING_CELL_FRAME_COUNT,
  liveActivityStateKey,
} from './liveActivityController';

test('live activity pulse resets on a real run phase change and continues until settlement', () => {
  const timers: Array<{
    callback: () => void;
    delayMs: number;
    handle: ReturnType<typeof setTimeout>;
  }> = [];
  const frames: number[] = [];
  let longWaits = 0;
  const controller = new LiveActivityController({
    onTick: (frame) => frames.push(frame),
    onLongWait: () => {
      longWaits += 1;
    },
    setTimer: (callback, delayMs) => {
      const handle = {} as ReturnType<typeof setTimeout>;
      timers.push({ callback, delayMs, handle });
      return handle;
    },
    clearTimer: (handle) => {
      const index = timers.findIndex((timer) => timer.handle === handle);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  const thinking = run('thinking');

  controller.sync(thinking);
  assert.equal(controller.frame, 0);
  assert.equal(controller.longWaiting, false);
  assert.equal(timers.length, 2);

  runTimer(timers, 240);
  assert.equal(controller.frame, 1);
  assert.deepEqual(frames, [1]);
  assert.equal(timers.length, 2);

  controller.sync(thinking);
  assert.equal(controller.frame, 1);
  assert.equal(timers.length, 2);

  controller.sync(run('using_tool'));
  assert.equal(controller.frame, 0);
  assert.equal(controller.longWaiting, false);
  assert.equal(timers.length, 2);

  for (let index = 0; index < LOADING_CELL_FRAME_COUNT; index += 1) {
    runTimer(timers, 240);
  }
  assert.equal(controller.frame, LOADING_CELL_FRAME_COUNT);
  assert.equal(timers.length, 2);
  assert.deepEqual(
    frames.slice(-LOADING_CELL_FRAME_COUNT),
    Array.from(
      { length: LOADING_CELL_FRAME_COUNT },
      (_, index) => index + 1,
    ),
  );
  runTimer(timers, 10_000);
  assert.equal(controller.longWaiting, true);
  assert.equal(longWaits, 1);
  assert.equal(timers.length, 1);
  runTimer(timers, 240);
  assert.equal(controller.frame, LOADING_CELL_FRAME_COUNT + 1);
  assert.equal(timers.length, 1);
  controller.sync(null);
  assert.equal(timers.length, 0);
});

test('live activity pulse cancels when the run settles or the controller ends', () => {
  const timers: Array<{
    callback: () => void;
    delayMs: number;
    handle: ReturnType<typeof setTimeout>;
  }> = [];
  const frames: number[] = [];
  const controller = new LiveActivityController({
    onTick: (frame) => frames.push(frame),
    onLongWait: () => assert.fail('settled run reached long-wait callback'),
    setTimer: (callback, delayMs) => {
      const handle = {} as ReturnType<typeof setTimeout>;
      timers.push({ callback, delayMs, handle });
      return handle;
    },
    clearTimer: (handle) => {
      const index = timers.findIndex((timer) => timer.handle === handle);
      if (index >= 0) timers.splice(index, 1);
    },
  });

  controller.sync(run('streaming'));
  assert.equal(timers.length, 2);
  controller.sync(null);
  assert.equal(controller.frame, 0);
  assert.equal(timers.length, 0);

  controller.sync(null);
  controller.sync(run('thinking'));
  assert.equal(timers.length, 2);
  controller.destroy();
  assert.equal(timers.length, 0);
  controller.sync(run('using_tool'));
  assert.equal(timers.length, 0);
  assert.deepEqual(frames, []);
});

test('live activity state key ignores timestamps but includes visible phase', () => {
  assert.equal(liveActivityStateKey(null), null);
  assert.equal(
    liveActivityStateKey({
      ...run('thinking'),
      startedAt: 1,
      updatedAt: 2,
    }),
    'request:running:thinking',
  );
  assert.equal(
    liveActivityStateKey({
      requestId: 'request',
      state: 'interrupting',
      startedAt: 1,
      updatedAt: 2,
    }),
    'request:interrupting',
  );
});

function run(
  activity: Extract<AgentRunView, { state: 'running' }>['activity'],
): AgentRunView {
  return {
    requestId: 'request',
    state: 'running',
    activity,
  };
}

function runTimer(
  timers: Array<{
    callback: () => void;
    delayMs: number;
    handle: ReturnType<typeof setTimeout>;
  }>,
  delayMs: number,
) {
  const index = timers.findIndex((timer) => timer.delayMs === delayMs);
  assert.notEqual(index, -1, `missing ${delayMs}ms timer`);
  const [timer] = timers.splice(index, 1);
  timer?.callback();
}
