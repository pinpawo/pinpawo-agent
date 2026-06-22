import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLocalServerTuiSnapshot } from './localServerTuiSnapshot';
import type { LocalServerDeps } from './localServerTypes';

test('buildLocalServerTuiSnapshot returns native core snapshot shape', () => {
  const snapshot = buildLocalServerTuiSnapshot({
    sessionId: 'chat:pet-a',
    kind: 'chat',
    messages: [
      { role: 'user', text: 'hello' },
      { role: 'system', text: 'notice' },
      { role: 'assistant', text: 'hi' },
    ],
    deps: {
      actorId: 'pet-a',
      llmConfig: {
        apiKey: 'test',
        baseUrl: 'http://localhost',
        model: 'test-model',
        contextWindowTokens: 32000,
      },
      workdir: '/tmp/work',
    } as LocalServerDeps,
    pendingReview: {
      requestId: 'req-review',
      reviewId: 'review-1',
      sessionId: 'chat:pet-a',
      actor: { petId: 'pet-a' },
      review: {
        id: 'review-1',
        schemaVersion: 1,
        view: { kind: 'plain', body: 'Approve?' },
        options: [],
      },
    },
  });

  assert.equal(snapshot.sessionId, 'chat:pet-a');
  assert.deepEqual(snapshot.timeline.map((entry) => [entry.id, entry.type, entry.type === 'message' ? entry.role : '']), [
    ['message:0:user', 'message', 'user'],
    ['message:2:assistant', 'message', 'assistant'],
  ]);
  assert.equal(snapshot.activeRunId, 'req-review');
  assert.equal(snapshot.runs[0]?.pendingReview?.review?.id, 'review-1');
  assert.equal(snapshot.runs[0]?.pendingReview?.petId, 'pet-a');
  assert.equal(snapshot.runtime?.model, 'test-model');
  assert.equal(snapshot.runtime?.contextWindow, 32000);
});
