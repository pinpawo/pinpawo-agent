import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAgentSessionSnapshot } from '@pinpawo/agent-session';
import { buildLocalAgentSessionSnapshot } from './localAgentSessionSnapshot';
import type { LocalServerDeps } from './localServerTypes';
import { createTestModelServerDeps } from './testing/modelProfiles';

test('buildLocalAgentSessionSnapshot returns a native LocalAgentSession snapshot', () => {
  const snapshot = buildLocalAgentSessionSnapshot({
    sessionId: 'chat:pet-a',
    kind: 'chat',
    messages: [
      { role: 'user', text: 'hello', createdAt: '2026-06-01T01:00:00.000Z' },
      { role: 'subagent', requestId: 'run-1', text: 'handoff result' },
      { role: 'assistant', text: 'hi' },
    ],
    deps: {
      actorId: 'pet-a',
      ...createTestModelServerDeps({ contextWindowTokens: 32000 }),
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
    requiredInputModalities: ['text', 'image'],
    sessionTokenUsage: {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      source: 'provider',
      scope: 'session',
    },
    pendingReview: {
      requestId: 'req-review',
      sessionId: 'chat:pet-a',
      actor: { petId: 'pet-a' },
      reviewAction: {
        actionId: 'interrupt-1',
        reviews: [{
          interactionId: 'review-1',
          schemaVersion: 2,
          view: { kind: 'plain', body: 'Approve?' },
          options: [{
            id: 'approve',
            label: 'Approve',
            batchSubmission: 'immediate',
          }],
        }],
      },
    },
    currentPlan: {
      items: [{
        id: 'delegation-1',
        capability: 'explore',
        task: 'Inspect the repository',
        status: 'active',
      }],
    },
  });

  assert.equal(snapshot.version, 4);
  assert.equal(snapshot.session.sessionId, 'chat:pet-a');
  assert.deepEqual(snapshot.session.timeline.map((entry) => [entry.id, entry.type, entry.type === 'message' ? entry.role : '']), [
    ['message:0:user', 'message', 'user'],
    ['message:1:subagent', 'message', 'subagent'],
    ['message:2:assistant', 'message', 'assistant'],
  ]);
  assert.equal(
    snapshot.session.timeline[0]?.type === 'message' ? snapshot.session.timeline[0].createdAt : undefined,
    '2026-06-01T01:00:00.000Z',
  );
  assert.equal(
    snapshot.session.timeline[1]?.type === 'message'
      ? snapshot.session.timeline[1].requestId
      : undefined,
    'run-1',
  );
  assert.ok(parseAgentSessionSnapshot(JSON.parse(JSON.stringify(snapshot))));
  assert.equal(snapshot.session.activeRun?.requestId, 'req-review');
  assert.equal(snapshot.session.activeRun?.state, 'waiting_review');
  if (snapshot.session.activeRun?.state !== 'waiting_review') assert.fail('expected waiting review');
  assert.equal(snapshot.session.activeRun.reviewAction.reviews[0]?.interactionId, 'review-1');
  assert.equal(snapshot.session.activeRun.reviewAction.petId, 'pet-a');
  assert.deepEqual(snapshot.session.currentPlan, {
    items: [{
      id: 'delegation-1',
      capability: 'explore',
      task: 'Inspect the repository',
      status: 'active',
    }],
  });
  assert.equal(snapshot.session.runtime?.model, 'test-model');
  assert.equal(snapshot.session.runtime?.modelProfileId, 'test-profile');
  assert.deepEqual(
    snapshot.session.runtime?.requiredInputModalities,
    ['text', 'image'],
  );
  assert.equal(snapshot.session.runtime?.modelProfileCompatible, false);
  assert.equal(snapshot.session.runtime?.contextWindow, 32000);
  assert.equal(snapshot.session.runtime?.cwd, '/tmp/work');
  assert.equal(snapshot.session.runtime?.workspaceId, 'workspace-test');
  assert.equal(snapshot.session.runtime?.workspaceName, 'Workspace Test');
  assert.equal(snapshot.session.runtime?.workspaceRoot, '/tmp/work');
  assert.deepEqual(snapshot.session.sessionTokenUsage, {
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    contextWindow: 32000,
    source: 'provider',
    scope: 'session',
  });
});

test('buildLocalAgentSessionSnapshot preserves an in-flight running request', () => {
  const snapshot = buildLocalAgentSessionSnapshot({
    sessionId: 'chat:pet-a',
    kind: 'chat',
    messages: [],
    deps: {
      actorId: 'pet-a',
      workdir: '/tmp/work',
      ...createTestModelServerDeps(),
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
    activeRun: {
      requestId: 'req-live',
      state: 'running',
      activity: 'thinking',
      startedAt: 1_700_000_000_000,
    },
  });

  assert.deepEqual(snapshot.session.activeRun, {
    requestId: 'req-live',
    state: 'running',
    activity: 'thinking',
    startedAt: 1_700_000_000_000,
  });
  assert.ok(parseAgentSessionSnapshot(JSON.parse(JSON.stringify(snapshot))));
});
