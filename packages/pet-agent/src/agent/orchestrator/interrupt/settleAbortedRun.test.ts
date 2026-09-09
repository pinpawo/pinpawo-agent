import assert from 'node:assert/strict';
import test from 'node:test';
import { settleAbortedRun } from './settleAbortedRun';

function graphOf(snapshot: unknown) {
  const reads: number[] = [];
  return {
    reads,
    graph: {
      getState: async () => {
        reads.push(1);
        return snapshot;
      },
    },
  };
}

const pendingDelegation = {
  values: {
    runSupervisorState: {
      goal: 'Work',
      plan: [{ id: 'task', capability: 'general', task: 'Work', status: 'pending' }],
    },
  },
};

test('settleAbortedRun reports an interrupt that was already pending', async () => {
  const { graph } = graphOf({
    ...pendingDelegation,
    next: ['capability'],
    tasks: [{ interrupts: [{ id: 'interrupt-1', value: { kind: 'pause_task' } }] }],
  });

  // An interrupt raised before the abort landed owns the boundary.
  const settled = await settleAbortedRun(graph);
  assert.equal(settled?.interruptId, 'interrupt-1');
});

test('settleAbortedRun leaves a finished run alone', async () => {
  const { graph } = graphOf({ ...pendingDelegation, next: [], tasks: [] });

  assert.equal(await settleAbortedRun(graph), null);
});

test('settleAbortedRun does not turn cancelled execution into a synthetic interrupt', async () => {
  // Cancellation is not a native interrupt. Whatever the run was in the
  // middle of, settling only reads — it never writes a resumable pause.
  for (const pending of ['capability', 'throwRunFailure', 'answer']) {
    const { graph, reads } = graphOf({
      ...pendingDelegation,
      next: [pending],
      tasks: [],
    });
    assert.equal(
      await settleAbortedRun(graph),
      null,
      'only a future user run may determine whether work continues',
    );
    assert.equal(reads.length, 1, 'settling reads the checkpoint once and writes nothing');
  }
});
