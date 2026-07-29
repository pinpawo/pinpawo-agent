import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApprovalState } from '../overlays/approvalModel';
import { resolveGlobalInterruptAction } from './globalInterrupt';

test('global Ctrl+C cancels review, interrupts once, then exits', () => {
  assert.equal(resolveGlobalInterruptAction({
    approval: approvalState('ready'),
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
    approval: approvalState('resolution-sent'),
    activeRun: {
      requestId: 'review',
      state: 'waiting_review',
      reviewAction: {
        actionId: 'action',
        reviews: [],
      },
    },
  }), 'interrupt-run');
  assert.equal(resolveGlobalInterruptAction({
    approval: {
      ...approvalState('resolution-sent'),
      interruptSent: true,
    },
    activeRun: {
      requestId: 'review',
      state: 'waiting_review',
      reviewAction: {
        actionId: 'action',
        reviews: [],
      },
    },
  }), 'exit');
  assert.equal(resolveGlobalInterruptAction({
    approval: { phase: 'closed' },
    activeRun: {
      requestId: 'run',
      state: 'running',
      activity: 'streaming',
    },
  }), 'interrupt-run');
  assert.equal(resolveGlobalInterruptAction({
    approval: { phase: 'closed' },
    activeRun: {
      requestId: 'run',
      state: 'interrupting',
    },
  }), 'exit');
  assert.equal(resolveGlobalInterruptAction({
    approval: { phase: 'closed' },
    activeRun: null,
  }), 'exit');
});

function approvalState(phase: 'ready' | 'resolution-sent') {
  return {
    phase,
    requestId: 'review',
    action: {
      actionId: 'action',
      reviews: [],
    },
    reviewIndex: 0,
    decisions: [],
    selectedIndex: 0,
    contentOffset: 0,
    draft: '',
    interruptSent: false,
  } satisfies ApprovalState;
}
