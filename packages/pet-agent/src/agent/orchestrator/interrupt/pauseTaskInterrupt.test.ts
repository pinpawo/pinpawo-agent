import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PAUSE_TASK_INTERRUPT_STATE_KEY,
  PauseTaskInterruptSignal,
  pauseTaskInterrupt,
  propagatePauseTaskInterrupt,
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
