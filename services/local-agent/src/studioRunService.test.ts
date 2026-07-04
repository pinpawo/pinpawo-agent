import assert from 'node:assert/strict';
import test from 'node:test';
import { buildStudioRunIdentity, type StudioTurnResult } from '@pinpawo/pet-agent';
import type { BuildStudioInput, BuildStudioResult } from './studio/studioRuntime';
import type { LocalServerDeps } from './localServerTypes';
import {
  StudioRunService,
} from './studioRunService';

function createDeps(): LocalServerDeps {
  return {
    actorId: 'pet-a',
    llmConfig: {
      provider: 'openai',
      model: 'test-model',
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
    } as unknown as LocalServerDeps['llmConfig'],
    workdir: '/tmp/legacy-workdir',
    runtimeConfig: {
      workdir: '/tmp/workspace',
      stateRoot: '/tmp/workspace/.pinpawo',
      studioConfigPath: '/tmp/workspace/.pinpawo/studio.json',
      studioDueRunsPath: '/tmp/workspace/.pinpawo/studio-due-runs.json',
      petsDir: '/tmp/workspace/.pinpawo/pets',
      studioWikiBaseDir: '/tmp/workspace/.pinpawo/studio-wiki',
      checkpointPath: '/tmp/workspace/.pinpawo/checkpoints.json',
      tuiCheckpointPath: '/tmp/workspace/.pinpawo/checkpoints-tui.json',
      tuiSessionPath: '/tmp/workspace/.pinpawo/tui-sessions.json',
      capabilityArtifactRoot: '/tmp/workspace/.pinpawo/capability-artifacts',
    },
    localToolkits: [{ name: 'local-toolkit' }] as LocalServerDeps['localToolkits'],
    pluginToolkits: [{ name: 'plugin-toolkit' }] as LocalServerDeps['pluginToolkits'],
    localCapabilities: [{ name: 'local-capability' }] as LocalServerDeps['localCapabilities'],
    userCapabilities: [{
      meta: { id: 'user-cap' },
      capability: { name: 'user-capability' },
    }] as LocalServerDeps['userCapabilities'],
  };
}

test('StudioRunService runs Studio with runtimeConfig-scoped paths', async () => {
  const buildInputs: BuildStudioInput[] = [];
  const invokeInputs: Array<{
    userRequest: string;
    conversationId?: string;
    turnId?: string;
  }> = [];
  const progressEvents: unknown[] = [];
  const service = new StudioRunService({
    buildStudio: async (input) => {
      buildInputs.push(input);
      let result: StudioTurnResult | null = null;
      return {
        resolved: {} as BuildStudioResult['resolved'],
        orchestrator: {
          submitRequest: async (turn: {
            userRequest: string;
            conversationId?: string;
            turnId?: string;
            onTurnEvent?: (event: unknown) => void;
          }) => {
            invokeInputs.push({
              userRequest: turn.userRequest,
              conversationId: turn.conversationId,
              turnId: turn.turnId,
            });
            turn.onTurnEvent?.({ type: 'turn_started' });
            result = {
              turnId: turn.turnId ?? 'run-1',
              outcome: {
                outcome: 'done',
                reply: 'done reply',
                finalPetRunId: 'pet-run-1',
              },
              studio: {},
            } as StudioTurnResult;
            return { runId: turn.turnId ?? 'run-1', status: 'accepted' };
          },
          waitForRun: async () => {
            assert.ok(result, 'submitRequest should run before waitForRun');
            return result;
          },
        } as unknown as BuildStudioResult['orchestrator'],
      };
    },
  });

  const result = await service.run({
    deps: createDeps(),
    runId: 'run-1',
    userRequest: 'plan this',
    conversationId: 'conversation-1',
    ownerUserId: 'user-1',
    bridge: {
      send: () => undefined,
      requestId: 'run-1',
      slot: { current: null },
    },
    onProgress: (event) => progressEvents.push(event),
  });

  assert.equal(buildInputs.length, 1);
  assert.equal(buildInputs[0]?.ownerUserId, 'user-1');
  assert.equal(buildInputs[0]?.workdir, '/tmp/workspace');
  assert.equal(buildInputs[0]?.studioConfigPath, '/tmp/workspace/.pinpawo/studio.json');
  assert.equal(buildInputs[0]?.petsDir, '/tmp/workspace/.pinpawo/pets');
  assert.equal(buildInputs[0]?.wikiBaseDir, '/tmp/workspace/.pinpawo/studio-wiki');
  assert.deepEqual(buildInputs[0]?.capabilities.map((item) => item.name), [
    'local-capability',
    'user-capability',
  ]);
  assert.deepEqual(buildInputs[0]?.toolkits?.map((item) => item.name), [
    'plugin-toolkit',
    'local-toolkit',
  ]);
  assert.deepEqual(invokeInputs, [{
    userRequest: 'plan this',
    conversationId: 'conversation-1',
    turnId: 'run-1',
  }]);
  assert.deepEqual(progressEvents, [{ type: 'turn_started' }]);
  assert.equal(result.idempotencyKey, 'studio:conversation-1:run:run-1');
  assert.equal(result.workdir, '/tmp/workspace');
  assert.equal(result.turn.outcome.outcome, 'done');
});

test('StudioRunService falls back to deps.workdir when runtimeConfig is absent', async () => {
  const buildInputs: BuildStudioInput[] = [];
  const service = new StudioRunService({
    buildStudio: async (input) => {
      buildInputs.push(input);
      let result: StudioTurnResult | null = null;
      return {
        resolved: {} as BuildStudioResult['resolved'],
        orchestrator: {
          submitRequest: async (turn: {
            userRequest: string;
            conversationId?: string;
            turnId?: string;
            onTurnEvent?: (event: unknown) => void;
          }) => {
            turn.onTurnEvent?.({ type: 'turn_started' });
            result = {
              turnId: turn.turnId ?? 'run-legacy',
              outcome: {
                outcome: 'done',
                reply: 'legacy reply',
                finalPetRunId: 'pet-run-legacy',
              },
              studio: {},
            } as StudioTurnResult;
            return { runId: turn.turnId ?? 'run-legacy', status: 'accepted' };
          },
          waitForRun: async () => {
            assert.ok(result, 'submitRequest should run before waitForRun');
            return result;
          },
        } as unknown as BuildStudioResult['orchestrator'],
      };
    },
  });

  const deps = createDeps();
  const result = await service.run({
    deps: {
      ...deps,
      runtimeConfig: undefined,
    },
    runId: 'run-2',
    userRequest: 'legacy plan this',
    ownerUserId: 'user-legacy',
    bridge: {
      send: () => undefined,
      requestId: 'run-2',
      slot: { current: null },
    },
  });

  assert.equal(buildInputs.length, 1);
  assert.equal(buildInputs[0]?.workdir, '/tmp/legacy-workdir');
  assert.equal(buildInputs[0]?.studioConfigPath, undefined);
  assert.equal(buildInputs[0]?.petsDir, undefined);
  assert.equal(buildInputs[0]?.wikiBaseDir, undefined);
  assert.equal(result.idempotencyKey, 'studio:run-2:run:run-2');
  assert.equal(result.workdir, '/tmp/legacy-workdir');
  assert.equal(result.turn.outcome.outcome, 'done');
});

test('buildStudioRunIdentity is scoped by conversation and run', () => {
  const identity = buildStudioRunIdentity({ conversationId: 'conv-a', runId: 'run-a' });
  assert.equal(identity.conversationId, 'conv-a');
  assert.equal(identity.runId, 'run-a');
  assert.equal(
    identity.idempotencyKey,
    'studio:conv-a:run:run-a',
  );
});
