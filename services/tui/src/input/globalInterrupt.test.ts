import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveGlobalInterruptAction } from './globalInterrupt';

test('global Ctrl+C cancels review, interrupts once, then exits', () => {
  assert.equal(resolveGlobalInterruptAction({
    approvalPhase: 'ready',
    activeRun: {
      requestId: 'review',
      state: 'waiting_review',
      reviewAction: {
        actionId: 'action',
        reviews: [],
      },
    },
  }), 'cancel-review');
  assert.equal(resolveGlobalInterruptAction({
    approvalPhase: 'closed',
    activeRun: {
      requestId: 'run',
      state: 'running',
      activity: 'streaming',
    },
  }), 'interrupt-run');
  assert.equal(resolveGlobalInterruptAction({
    approvalPhase: 'closed',
    activeRun: {
      requestId: 'run',
      state: 'interrupting',
    },
  }), 'exit');
  assert.equal(resolveGlobalInterruptAction({
    approvalPhase: 'closed',
    activeRun: null,
  }), 'exit');
});
