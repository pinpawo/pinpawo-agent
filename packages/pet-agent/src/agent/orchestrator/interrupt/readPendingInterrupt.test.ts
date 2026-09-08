import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readPendingInterrupt,
  UnknownInterruptPayloadError,
} from './readPendingInterrupt';

const review = {
  id: 'review-1',
  schemaVersion: 1 as const,
  view: { kind: 'plain' as const, body: 'Approve?' },
  options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' as const } }],
};

function snapshotWith(value: unknown, id = 'interrupt-1') {
  return { tasks: [{ interrupts: [{ id, value }] }] };
}

test('readPendingInterrupt decodes a single review interrupt with its id', () => {
  const pending = readPendingInterrupt(
    snapshotWith({ kind: 'review', review }),
  );

  assert.equal(pending?.interruptId, 'interrupt-1');
  assert.equal(pending?.payload.kind, 'human_review');
  assert.deepEqual(
    pending?.payload.kind === 'human_review' ? pending.payload.reviews : null,
    [review],
  );
});

test('readPendingInterrupt decodes a review batch as one interrupt carrying every review', () => {
  const second = { ...review, id: 'review-2' };
  const pending = readPendingInterrupt(snapshotWith({
    kind: 'review_batch',
    reviews: [{ kind: 'review', review }, { kind: 'review', review: second }],
  }));

  assert.equal(pending?.interruptId, 'interrupt-1');
  assert.deepEqual(
    pending?.payload.kind === 'human_review' ? pending.payload.reviews : null,
    [review, second],
  );
});

test('readPendingInterrupt decodes a task pause through the same shape as a review', () => {
  const pending = readPendingInterrupt(
    snapshotWith({ kind: 'pause_task' }, 'interrupt-pause'),
  );

  // The pause carries an id exactly like a review does; nothing above the
  // Runtime needs a second way to learn a task is paused.
  assert.deepEqual(pending, {
    interruptId: 'interrupt-pause',
    payload: { kind: 'pause_task' },
  });
});

test('readPendingInterrupt reports nothing for a snapshot with no pending interrupt', () => {
  assert.equal(readPendingInterrupt({ tasks: [] }), null);
  assert.equal(readPendingInterrupt({ tasks: [{ interrupts: [] }] }), null);
  assert.equal(readPendingInterrupt(null), null);
});

test('readPendingInterrupt finds the interrupt a later task carries', () => {
  const pending = readPendingInterrupt({
    tasks: [
      { interrupts: [] },
      { interrupts: [{ id: 'interrupt-2', value: { kind: 'pause_task' } }] },
    ],
  });

  assert.equal(pending?.interruptId, 'interrupt-2');
});

test('readPendingInterrupt throws on a payload it cannot decode', () => {
  // Reporting "no interrupt" would let the Host admit new work against a
  // checkpoint that is waiting for a person.
  assert.throws(
    () => readPendingInterrupt(snapshotWith({ kind: 'from_a_newer_runtime' })),
    (error: unknown) => error instanceof UnknownInterruptPayloadError
      && error.interruptId === 'interrupt-1',
  );
});

test('readPendingInterrupt refuses an interrupt with no usable id', () => {
  assert.equal(
    readPendingInterrupt({ tasks: [{ interrupts: [{ value: { kind: 'pause_task' } }] }] }),
    null,
  );
});
