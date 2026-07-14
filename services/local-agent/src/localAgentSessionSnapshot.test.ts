import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLocalAgentSessionSnapshot } from './localAgentSessionSnapshot';
import type { LocalServerDeps } from './localServerTypes';

test('buildLocalAgentSessionSnapshot returns a native LocalAgentSession snapshot', () => {
  const snapshot = buildLocalAgentSessionSnapshot({
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
      sessionId: 'chat:pet-a',
      actor: { petId: 'pet-a' },
      reviewAction: {
        actionId: 'interrupt-1',
        status: 'waiting',
        reviews: [{
          id: 'review-1',
          schemaVersion: 1,
          view: { kind: 'plain', body: 'Approve?' },
          options: [],
        }],
      },
    },
  });

  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.session.sessionId, 'chat:pet-a');
  assert.deepEqual(snapshot.session.timeline.map((entry) => [entry.id, entry.type, entry.type === 'message' ? entry.role : '']), [
    ['message:0:user', 'message', 'user'],
    ['message:2:assistant', 'message', 'assistant'],
  ]);
  assert.equal(
    snapshot.session.timeline[0]?.type === 'message' ? snapshot.session.timeline[0].createdAt : undefined,
    '2026-06-01T01:00:00.000Z',
  );
  assert.equal(snapshot.session.activeRun?.requestId, 'req-review');
  assert.equal(snapshot.session.activeRun?.reviewAction?.reviews[0]?.id, 'review-1');
  assert.equal(snapshot.session.activeRun?.reviewAction?.petId, 'pet-a');
  assert.equal(snapshot.session.runtime?.model, 'test-model');
  assert.equal(snapshot.session.runtime?.contextWindow, 32000);
  assert.equal(snapshot.session.runtime?.cwd, '/tmp/work');
  assert.equal(snapshot.session.runtime?.workspaceId, 'workspace-test');
  assert.equal(snapshot.session.runtime?.workspaceName, 'Workspace Test');
  assert.equal(snapshot.session.runtime?.workspaceRoot, '/tmp/work');
});
