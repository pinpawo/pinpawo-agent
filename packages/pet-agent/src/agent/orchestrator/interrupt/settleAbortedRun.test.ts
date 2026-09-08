import assert from 'node:assert/strict';
import test from 'node:test';
import { settleAbortedRun } from './settleAbortedRun';

function graphOf(snapshots: unknown[]) {
  const calls: Array<{ kind: string; asNode?: string }> = [];
  let index = 0;
  return {
    calls,
    graph: {
      getState: async () => snapshots[Math.min(index, snapshots.length - 1)],
      updateState: async (_values: unknown, asNode?: string) => {
        calls.push({ kind: 'updateState', ...(asNode ? { asNode } : {}) });
        index += 1;
      },
      resume: async () => {
        calls.push({ kind: 'resume' });
        index += 1;
      },
    },
  };
}

const pendingDelegation = { values: { taskActiveDelegation: { status: 'pending' } } };

test('settleAbortedRun reports an interrupt that was already pending', async () => {
  const { graph, calls } = graphOf([{
    ...pendingDelegation,
    next: ['capability'],
    tasks: [{ interrupts: [{ id: 'interrupt-1', value: { kind: 'pause_task' } }] }],
  }]);

  // An interrupt raised before the abort landed owns the boundary; settling
  // again would strand it.
  const settled = await settleAbortedRun(graph);
  assert.equal(settled.status, 'paused');
  assert.deepEqual(calls, [], 'an owned boundary is left untouched');
});

test('settleAbortedRun leaves a finished run alone', async () => {
  const { graph, calls } = graphOf([{ ...pendingDelegation, next: [], tasks: [] }]);

  assert.deepEqual(await settleAbortedRun(graph), { status: 'finished' });
  assert.deepEqual(calls, []);
});

test('settleAbortedRun does not pause an abort with no delegation to continue', async () => {
  // Cancelling while answering or planning leaves nothing a person can steer.
  const { graph, calls } = graphOf([{
    values: { taskActiveDelegation: null },
    next: ['answer'],
    tasks: [],
  }]);

  assert.deepEqual(await settleAbortedRun(graph), { status: 'finished' });
  assert.deepEqual(calls, [], 'a run that merely ended is not rewritten');
});

test('settleAbortedRun does not pause a delegation awaiting its Supervisor boundary', async () => {
  const { graph, calls } = graphOf([{
    values: { taskActiveDelegation: { status: 'awaiting_decision' } },
    next: ['capability'],
    tasks: [],
  }]);

  assert.deepEqual(await settleAbortedRun(graph), { status: 'finished' });
  assert.deepEqual(calls, []);
});

test('settleAbortedRun writes through the node the abort left pending', async () => {
  const { graph, calls } = graphOf([
    { ...pendingDelegation, next: ['throwRunFailure'], tasks: [] },
    { ...pendingDelegation, next: ['pauseGate'], tasks: [] },
    {
      ...pendingDelegation,
      next: ['pauseGate'],
      tasks: [{ interrupts: [{ id: 'interrupt-pause', value: { kind: 'pause_task' } }] }],
    },
  ]);

  const settled = await settleAbortedRun(graph);

  assert.equal(settled.status, 'paused');
  assert.equal(
    settled.status === 'paused' ? settled.pendingInterrupt.interruptId : null,
    'interrupt-pause',
  );
  // Written as the pending node, so its task is satisfied rather than repeated.
  assert.deepEqual(calls, [
    { kind: 'updateState', asNode: 'throwRunFailure' },
    { kind: 'resume' },
  ]);
});

test('settleAbortedRun reports finished when the thread raises no interrupt', async () => {
  // Defensive: if the gate is somehow unreachable, say the run ended rather
  // than claim a pause the interface could never continue.
  const { graph } = graphOf([
    { ...pendingDelegation, next: ['capability'], tasks: [] },
    { ...pendingDelegation, next: [], tasks: [] },
    { ...pendingDelegation, next: [], tasks: [] },
  ]);

  assert.deepEqual(await settleAbortedRun(graph), { status: 'finished' });
});
