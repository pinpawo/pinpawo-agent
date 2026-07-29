import assert from 'node:assert/strict';
import test from 'node:test';
import {
  InterruptPendingNoticeController,
} from './interruptPendingNoticeController';

test('interrupt pending notice fires once and cancels on authoritative settlement', () => {
  const scheduler = createScheduler();
  const pending: string[] = [];
  const controller = new InterruptPendingNoticeController({
    onPendingTooLong: (requestId) => pending.push(requestId),
    delayMs: 10_000,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
  });

  controller.sync(interrupting('run-1'));
  controller.sync(interrupting('run-1'));
  assert.equal(scheduler.timers.length, 1);
  assert.equal(scheduler.timers[0]?.delayMs, 10_000);

  scheduler.fire(0);
  assert.deepEqual(pending, ['run-1']);
  controller.sync(interrupting('run-1'));
  assert.equal(scheduler.activeTimers.length, 0);

  controller.sync({ phase: 'closed' });
  controller.sync(interrupting('run-2'));
  assert.equal(scheduler.activeTimers.length, 1);
  controller.sync({ phase: 'closed' });
  assert.equal(scheduler.activeTimers.length, 0);
  scheduler.fire(1);
  assert.deepEqual(pending, ['run-1']);

  controller.sync(interrupting('run-3'));
  controller.destroy();
  assert.equal(scheduler.activeTimers.length, 0);
});

function interrupting(requestId: string) {
  return {
    phase: 'interrupting' as const,
    requestId,
    pendingTooLong: false,
  };
}

function createScheduler() {
  type Timer = {
    callback: () => void;
    delayMs: number;
    cancelled: boolean;
  };
  const timers: Timer[] = [];
  return {
    timers,
    get activeTimers() {
      return timers.filter((timer) => !timer.cancelled);
    },
    setTimer(callback: () => void, delayMs: number) {
      const timer = {
        callback,
        delayMs,
        cancelled: false,
      };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer(handle: ReturnType<typeof setTimeout>) {
      (handle as unknown as Timer).cancelled = true;
    },
    fire(index: number) {
      const timer = timers[index];
      if (timer && !timer.cancelled) {
        timer.cancelled = true;
        timer.callback();
      }
    },
  };
}
