import assert from 'node:assert/strict';
import test from 'node:test';
import { LoadingCellController } from './loadingCellController';

test('loading cell pulse runs only while a waiting surface is visible', () => {
  const timers: Array<{
    callback: () => void;
    handle: ReturnType<typeof setTimeout>;
  }> = [];
  const frames: number[] = [];
  const controller = new LoadingCellController({
    onTick: (frame) => frames.push(frame),
    setTimer: (callback) => {
      const handle = {} as ReturnType<typeof setTimeout>;
      timers.push({ callback, handle });
      return handle;
    },
    clearTimer: (handle) => {
      const index = timers.findIndex((timer) => timer.handle === handle);
      if (index >= 0) timers.splice(index, 1);
    },
  });

  controller.sync(false);
  assert.equal(timers.length, 0);
  controller.sync(true);
  assert.equal(timers.length, 1);
  const first = timers.shift();
  first?.callback();
  assert.deepEqual(frames, [1]);
  assert.equal(timers.length, 1);

  controller.sync(false);
  assert.equal(timers.length, 0);
  assert.equal(controller.frame, 0);
  controller.destroy();
  controller.sync(true);
  assert.equal(timers.length, 0);
});
