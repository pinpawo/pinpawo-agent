import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePendingInterruptProjection } from './review';

test('public interrupt parser preserves both kinds and rejects internal review decisions/effects', () => {
  const pause = { interruptId: 'pause', payload: { kind: 'pause_task' } };
  assert.deepEqual(parsePendingInterruptProjection(pause), pause);
  const review = { interruptId: 'review', payload: { kind: 'human_review', interactions: [{
    interactionId: 'interaction', schemaVersion: 2,
    view: { kind: 'diff', patch: '+ change', summary: 'Summary' },
    options: [{ id: 'allow', label: 'Allow', batchSubmission: 'defer' }],
  }] } };
  assert.deepEqual(parsePendingInterruptProjection(review), review);
  for (const extra of [{ decision: { type: 'approve' } }, { effects: [{ type: 'graph.authorize_tool_action' }] }]) {
    const unsafe = structuredClone(review);
    Object.assign(unsafe.payload.interactions[0]!.options[0]!, extra);
    assert.equal(parsePendingInterruptProjection(unsafe), null);
  }
  for (const invalid of [null, {}, { ...pause, checkpointId: 'copied' }, { interruptId: '', payload: pause.payload },
    { interruptId: 'i', payload: { kind: 'human_review', interactions: [] } },
    { interruptId: 'i', payload: { kind: 'unknown' } }]) {
    assert.equal(parsePendingInterruptProjection(invalid), null);
  }
});
