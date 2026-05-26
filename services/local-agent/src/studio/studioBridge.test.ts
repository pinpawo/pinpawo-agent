import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HumanReviewRequest } from '@pinpawo/pet-agent';

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

function sampleRequest(overrides: Partial<HumanReviewRequest> = {}): HumanReviewRequest {
  return {
    kind: 'human_review',
    actionRequests: [],
    reviewConfigs: [],
    ...overrides,
  };
}

test('createPendingReviewSlot starts empty', () => {
  const slot = createPendingReviewSlot();
  assert.equal(slot.current, null);
});

test('resolveReview / rejectReview return false when slot empty', () => {
  const slot = createPendingReviewSlot();
  assert.equal(resolveReview(slot, { type: 'approve' }), false);
  assert.equal(rejectReview(slot, new Error('x')), false);
});

test('createWsHumanReviewer sends human_interrupt and resolves when slot resolved', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const slot = createPendingReviewSlot();
  const reviewer = createWsHumanReviewer({
    send: (msg) => sent.push(msg as Record<string, unknown>),
    requestId: 'r1',
    petId: 'planner',
    slot,
  });

  const promise = reviewer(sampleRequest({ prompt: 'go ahead?' }));

  // 推了 ws 消息
  assert.equal(sent.length, 1);
  const msg = sent[0];
  assert.equal(msg.type, 'human_interrupt');
  assert.equal(msg.requestId, 'r1');
  assert.equal(msg.petId, 'planner', 'human_interrupt should carry petId so TUI can attribute');
  assert.equal(msg.prompt, 'go ahead?');
  assert.ok(msg.payload, 'payload should carry the original request');

  // slot 占用中
  assert.ok(slot.current);
  assert.equal(slot.current!.petId, 'planner');
  assert.ok(slot.current!.reviewId);

  // resolve 解开 promise
  const ok = resolveReview(slot, { type: 'approve' });
  assert.equal(ok, true);
  assert.equal(slot.current, null);
  const decision = await promise;
  assert.equal(decision.type, 'approve');
});

test('createWsHumanReviewer falls back prompt text when request has no prompt', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const slot = createPendingReviewSlot();
  const reviewer = createWsHumanReviewer({
    send: (msg) => sent.push(msg as Record<string, unknown>),
    requestId: 'r1',
    petId: 'p',
    slot,
  });

  reviewer(sampleRequest({
    actionRequests: [{ name: 'shell', args: { cmd: 'ls' }, description: '执行 ls 命令' }],
  })).catch(() => {});
  assert.match(sent[0].prompt as string, /执行 ls 命令/);

  // 清掉 pending,再测无 description 时的兜底
  resolveReview(slot, { type: 'reject' });
  sent.length = 0;
  reviewer(sampleRequest({ actionRequests: [{ name: 'x', args: {} }] })).catch(() => {});
  assert.match(sent[0].prompt as string, /需要你的确认/);
});

test('createWsHumanReviewer rejects when slot already occupied', async () => {
  const slot = createPendingReviewSlot();
  const reviewer = createWsHumanReviewer({
    send: () => {},
    requestId: 'r1',
    petId: 'a',
    slot,
  });
  reviewer(sampleRequest({ prompt: 'q1' })).catch(() => {});

  await assert.rejects(
    reviewer(sampleRequest({ prompt: 'q2' })),
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
  const promise = reviewer(sampleRequest({ prompt: 'q' }));
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
