import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HumanReviewInterruptPayload } from '@pinpawo/pet-agent';

import {
  buildPetActorFromLocalConfig,
  createPendingReviewSlot,
  createWsHumanReviewer,
  rejectReview,
  resolveReview,
} from './studioBridge';
import type { PetLocalConfig } from './petConfig';

function basePet(overrides: Partial<PetLocalConfig> = {}): PetLocalConfig {
  return { petId: 'p1', name: 'Pet 1', capabilities: [], ...overrides };
}

function sampleReviewInterrupt(overrides: Partial<HumanReviewInterruptPayload> = {}): HumanReviewInterruptPayload {
  return {
    kind: 'review',
    review: {
      id: 'review-direct',
      schemaVersion: 1,
      view: {
        kind: 'plain',
        title: 'Direct review',
        body: 'Approve direct action?',
      },
      options: [{
        id: 'approve',
        label: 'Approve',
        decision: { type: 'approve' },
      }],
    },
    pendingAction: {
      actionId: 'call-1',
      toolName: 'run_shell',
      args: { command: 'git status' },
    },
    ...overrides,
  };
}

test('createPendingReviewSlot starts empty', () => {
  const slot = createPendingReviewSlot();
  assert.equal(slot.current, null);
});

test('resolveReview / rejectReview return false when slot empty', () => {
  const slot = createPendingReviewSlot();
  assert.equal(resolveReview(slot, { reviewId: 'review-direct', selectedOptionId: 'approve' }), false);
  assert.equal(rejectReview(slot, new Error('x')), false);
});

test('createWsHumanReviewer forwards canonical review specs unchanged', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const slot = createPendingReviewSlot();
  const reviewer = createWsHumanReviewer({
    send: (msg) => sent.push(msg as Record<string, unknown>),
    requestId: 'r1',
    petId: 'planner',
    slot,
  });

  const request = sampleReviewInterrupt();
  const promise = reviewer(request);

  assert.equal(sent.length, 1);
  const event = sent[0].event as {
    prompt: string;
    payload: unknown;
    review: { id: string; view: { title?: string; body: string } };
  };
  assert.equal(slot.current?.reviewId, 'review-direct');
  assert.equal(event.prompt, 'Direct review\nApprove direct action?');
  assert.equal(event.review.id, 'review-direct');
  assert.equal(event.review, request.review);
  assert.equal(event.payload, request);

  assert.equal(resolveReview(slot, { reviewId: 'review-direct', selectedOptionId: 'approve' }), true);
  assert.deepEqual(await promise, { reviewId: 'review-direct', selectedOptionId: 'approve' });
});

test('createWsHumanReviewer rejects when slot already occupied', async () => {
  const slot = createPendingReviewSlot();
  const reviewer = createWsHumanReviewer({
    send: () => {},
    requestId: 'r1',
    petId: 'a',
    slot,
  });
  reviewer(sampleReviewInterrupt()).catch(() => {});

  await assert.rejects(
    reviewer(sampleReviewInterrupt({ review: { ...sampleReviewInterrupt().review, id: 'review-next' } })),
    /already pending/,
  );
});

test('rejectReview rejects pending promise and clears slot', async () => {
  const slot = createPendingReviewSlot();
  const reviewer = createWsHumanReviewer({
    send: () => {},
    requestId: 'r1',
    petId: 'a',
    slot,
  });
  const promise = reviewer(sampleReviewInterrupt());
  const ok = rejectReview(slot, new Error('ws closed'));
  assert.equal(ok, true);
  assert.equal(slot.current, null);
  await assert.rejects(promise, /ws closed/);
});

test('buildPetActorFromLocalConfig handles minimal config (all nullable fields default to null)', () => {
  const actor = buildPetActorFromLocalConfig(basePet(), null);
  assert.equal(actor.petId, 'p1');
  assert.equal(actor.name, 'Pet 1');
  assert.equal(actor.userId, null);
  assert.equal(actor.personality, null);
  assert.equal(actor.stage, null);
  assert.equal(actor.species, null);
});

test('buildPetActorFromLocalConfig carries optional fields and ownerUserId', () => {
  const actor = buildPetActorFromLocalConfig(
    basePet({ personality: 'creative', stage: 'adult', species: 'dog' }),
    'user-42',
  );
  assert.equal(actor.userId, 'user-42');
  assert.equal(actor.personality, 'creative');
  assert.equal(actor.stage, 'adult');
  assert.equal(actor.species, 'dog');
});
