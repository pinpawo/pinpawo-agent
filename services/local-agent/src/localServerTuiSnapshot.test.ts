import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLocalServerTuiSnapshot } from './localServerTuiSnapshot';
import type { LocalServerDeps } from './localServerTypes';

test('buildLocalServerTuiSnapshot returns native core snapshot shape', () => {
  const snapshot = buildLocalServerTuiSnapshot({
    sessionId: 'chat:pet-a',
    kind: 'chat',
    messages: [
      { role: 'user', text: 'hello', createdAt: '2026-06-01T01:00:00.000Z' },
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
      workdir: '/tmp/legacy-work',
      runtimeConfig: {
        workdir: '/tmp/work',
        workspace: {
          id: 'workspace-test',
          name: 'Workspace Test',
          rootPath: '/tmp/work',
        },
        stateRoot: '/tmp/work/.pinpawo',
        studioConfigPath: '/tmp/work/.pinpawo/studio.json',
        studioDueRunsPath: '/tmp/work/.pinpawo/studio-due-runs.json',
        petsDir: '/tmp/work/.pinpawo/pets',
        studioWikiBaseDir: '/tmp/work/.pinpawo/studio-wiki',
        checkpointPath: '/tmp/work/.pinpawo/checkpoints.json',
        tuiCheckpointPath: '/tmp/work/.pinpawo/checkpoints-tui.json',
        tuiSessionPath: '/tmp/work/.pinpawo/tui-sessions.json',
        capabilityArtifactRoot: '/tmp/work/.pinpawo/capability-artifacts',
      },
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
  assert.equal(
    snapshot.timeline[0]?.type === 'message' ? snapshot.timeline[0].createdAt : undefined,
    '2026-06-01T01:00:00.000Z',
  );
  assert.equal(snapshot.activeRunId, 'req-review');
  assert.equal(snapshot.runs[0]?.pendingReview?.review?.id, 'review-1');
  assert.equal(snapshot.runs[0]?.pendingReview?.petId, 'pet-a');
  assert.equal(snapshot.runtime?.model, 'test-model');
  assert.equal(snapshot.runtime?.contextWindow, 32000);
  assert.equal(snapshot.runtime?.cwd, '/tmp/work');
  assert.equal(snapshot.runtime?.workspaceId, 'workspace-test');
  assert.equal(snapshot.runtime?.workspaceName, 'Workspace Test');
  assert.equal(snapshot.runtime?.workspaceRoot, '/tmp/work');
});
