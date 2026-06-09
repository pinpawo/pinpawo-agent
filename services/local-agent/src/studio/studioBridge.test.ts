import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HumanReviewRequest, ToolReviewInterruptPayload } from '@pinpawo/pet-agent';

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

function sampleToolReview(overrides: Partial<ToolReviewInterruptPayload> = {}): ToolReviewInterruptPayload {
  return {
    kind: 'tool_review',
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
  assert.equal(resolveReview(slot, { type: 'approve' }), false);
  assert.equal(rejectReview(slot, new Error('x')), false);
});

test('createWsHumanReviewer sends human review event and resolves when slot resolved', async () => {
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
  assert.equal(msg.type, 'event');
  assert.equal(msg.requestId, 'r1');
  const event = msg.event as {
    type: string;
    requestId: string;
    prompt: string;
    payload: unknown;
    review?: { id: string; schemaVersion: number; view: { body: string }; options: Array<{ id: string }> };
    actor: { petId: string };
  };
  assert.equal(event.type, 'human_review.requested');
  assert.equal(event.requestId, 'r1');
  assert.equal(event.prompt, 'go ahead?');
  assert.deepEqual(event.payload, sampleRequest({ prompt: 'go ahead?' }));
  assert.deepEqual(event.actor, { petId: 'planner' });
  assert.equal(event.review?.id, slot.current?.reviewId);
  assert.equal(event.review?.schemaVersion, 1);
  assert.equal(event.review?.view.body, 'go ahead?');
  assert.deepEqual(event.review?.options.map((option) => option.id), ['approve', 'reject', 'respond']);

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
  assert.match((sent[0].event as { prompt?: string }).prompt ?? '', /执行 ls 命令/);

  // 清掉 pending,再测无 description 时的兜底
  resolveReview(slot, { type: 'reject' });
  sent.length = 0;
  reviewer(sampleRequest({ actionRequests: [{ name: 'x', args: {} }] })).catch(() => {});
  assert.match((sent[0].event as { prompt?: string }).prompt ?? '', /需要你的确认/);
});

test('createWsHumanReviewer forwards canonical tool review specs unchanged', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const slot = createPendingReviewSlot();
  const reviewer = createWsHumanReviewer({
    send: (msg) => sent.push(msg as Record<string, unknown>),
    requestId: 'r1',
    petId: 'planner',
    slot,
  });

  const request = sampleToolReview();
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

  assert.equal(resolveReview(slot, { type: 'approve' }), true);
  assert.equal((await promise).type, 'approve');
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
