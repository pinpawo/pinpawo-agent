import assert from 'node:assert/strict';
import test from 'node:test';
import { RunCommandSequencer } from './runCommandSequencer';

test('RunCommandSequencer releases a queued interrupt only after review resolution checkpointing', () => {
  const sequencer = new RunCommandSequencer();

  assert.equal(sequencer.beginReviewResolution('req-1'), true);
  assert.equal(sequencer.beginReviewResolution('req-1'), false);
  assert.equal(sequencer.queueRunInterrupt('req-1'), true);
  assert.equal(sequencer.markReviewResolutionCheckpointed('req-1'), true);
  assert.equal(sequencer.markReviewResolutionCheckpointed('req-1'), false);
});

test('RunCommandSequencer ignores unrelated and abandoned interrupts', () => {
  const sequencer = new RunCommandSequencer();

  assert.equal(sequencer.queueRunInterrupt('req-1'), false);
  assert.equal(sequencer.beginReviewResolution('req-1'), true);
  assert.equal(sequencer.queueRunInterrupt('req-1'), true);
  sequencer.abandonReviewResolution('req-1');
  assert.equal(sequencer.markReviewResolutionCheckpointed('req-1'), false);
});
