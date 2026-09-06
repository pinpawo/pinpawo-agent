import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PAUSE_TASK_INTERRUPT_STATE_KEY,
  PauseTaskInterruptSignal,
  pauseTaskInterrupt,
  propagatePauseTaskInterrupt,
  readPauseTaskInterrupt,
} from './pauseTaskInterrupt';

test('PauseTaskInterrupt owns commit-and-unwind materialization', () => {
  const update = pauseTaskInterrupt.enter({ messages: [] });

  assert.equal(update.jumpTo, 'end');
  assert.deepEqual(update[PAUSE_TASK_INTERRUPT_STATE_KEY], { kind: 'pause_task' });
});

test('PauseTaskInterrupt propagates across the private child boundary', () => {
  assert.throws(
    () => propagatePauseTaskInterrupt(
      { [PAUSE_TASK_INTERRUPT_STATE_KEY]: { kind: 'pause_task' } },
      { messages: [], artifacts: [] },
    ),
    (error) => error instanceof PauseTaskInterruptSignal
      && error.payload.kind === 'pause_task',
  );
});

test('PauseTaskInterrupt parses continue guidance', () => {
  assert.deepEqual(
    pauseTaskInterrupt.resume({ action: 'continue', guidance: '  try another way  ' }),
    { type: 'continue', guidance: 'try another way' },
  );
});

test('PauseTaskInterrupt is read only from explicit Runtime state', () => {
  assert.deepEqual(readPauseTaskInterrupt({
    values: { taskPauseInterrupt: { kind: 'pause_task' } },
  }), { kind: 'pause_task' });
  assert.equal(readPauseTaskInterrupt({
    values: {},
    next: ['answer'],
    tasks: [],
  }), null);
  assert.equal(readPauseTaskInterrupt({
    values: { taskActiveDelegation: { status: 'pending' } },
    next: [],
    tasks: [],
  }), null);
});
