import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { InflightRequestController } from './inflightRequestController';
import {
  LocalServerStudioHandler,
  type LocalServerStudioOutbound,
} from './localServerStudioHandler';
import { LocalServerStudioReviewRouter } from './localServerStudioReviews';
import { StudioNotConfiguredError, type BuildStudioInput, type BuildStudioResult } from './studio/studioRuntime';
import type { LocalServerDeps } from './localServerTypes';
import { sendLocalServerPeerEvent, type LocalServerPeer } from './localServerPeer';

const PEER_OUTBOUND: LocalServerStudioOutbound<LocalServerPeer> = {
  sendMessage: (peer, message) => peer.send(message),
  sendEvent: (peer, event) => sendLocalServerPeerEvent(peer, event),
};

function createFakePeer(sent: unknown[]): LocalServerPeer {
  return {
    isConnected: () => true,
    send(message) {
      sent.push(message);
      return true;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolveFn) => {
    resolve = resolveFn;
  });
  return { promise, resolve };
}

function createInflightController() {
  return new InflightRequestController<LocalServerPeer>({
    emitOperation: (peer, event) => sendLocalServerPeerEvent(peer, event),
    sendControl: (peer, message) => peer.send(message),
  });
}

function createDeps(): LocalServerDeps {
  const readFileTool = tool(
    async ({ path }: { path?: string }) => path ?? '',
    {
      name: 'read_file',
      description: 'Read a test file.',
      schema: z.object({ path: z.string().optional() }),
    },
  );
  return {
    actorId: 'pet-a',
    actorName: 'Pet A',
    workdir: '/tmp/pinpawo-test',
    llmConfig: {
      provider: 'openai',
      model: 'test-model',
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
    } as unknown as LocalServerDeps['llmConfig'],
    runtimeConfig: {
      workdir: '/tmp/pinpawo-test',
      stateRoot: '/tmp/pinpawo-test/.pinpawo',
      studioConfigPath: '/tmp/pinpawo-test/.pinpawo/studio.json',
      studioDueRunsPath: '/tmp/pinpawo-test/.pinpawo/studio-due-runs.json',
      petsDir: '/tmp/pinpawo-test/.pinpawo/pets',
      studioWikiBaseDir: '/tmp/pinpawo-test/.pinpawo/studio-wiki',
      checkpointPath: '/tmp/pinpawo-test/.pinpawo/checkpoints.json',
      tuiCheckpointPath: '/tmp/pinpawo-test/.pinpawo/checkpoints-tui.json',
      tuiSessionPath: '/tmp/pinpawo-test/.pinpawo/tui-sessions.json',
      capabilityArtifactRoot: '/tmp/pinpawo-test/.pinpawo/capability-artifacts',
    },
    localToolkits: [{
      name: 'local-toolkit',
      description: 'local toolkit',
      tools: [{
        tool: readFileTool,
        operation: {
          title: '读文件',
          summarizeInput: (input: unknown) => {
            const path = input && typeof input === 'object' && 'path' in input
              ? (input as { path?: unknown }).path
              : null;
            return typeof path === 'string' ? { target: path } : null;
          },
        },
      }],
    }] as LocalServerDeps['localToolkits'],
    pluginToolkits: [{ name: 'plugin-toolkit' }] as LocalServerDeps['pluginToolkits'],
    localCapabilities: [{ name: 'browser' }] as LocalServerDeps['localCapabilities'],
    userCapabilities: [{
      meta: { id: 'user-cap' },
      capability: { name: 'user-capability' },
    }] as LocalServerDeps['userCapabilities'],
  };
}

test('LocalServerStudioHandler emits progress and done response', async () => {
  const sent: unknown[] = [];
  const peer = createFakePeer(sent);
  const buildInputs: BuildStudioInput[] = [];
  const handler = new LocalServerStudioHandler({
    reviewRouter: new LocalServerStudioReviewRouter<LocalServerPeer>(),
    inflightRequests: createInflightController(),
    outbound: PEER_OUTBOUND,
    buildStudio: async (input) => {
      buildInputs.push(input);
      return {
        resolved: {} as BuildStudioResult['resolved'],
        orchestrator: {
          submitRequest: async (turn: {
            onTurnEvent: (event: Record<string, unknown>) => void;
          }) => {
            turn.onTurnEvent({ type: 'turn_started' });
            return { runId: 'run-100', status: 'accepted' };
          },
          waitForRun: async () => {
            return {
              outcome: {
                outcome: 'done',
                reply: 'done reply',
                finalPetRunId: 'pet-run-1',
              },
            };
          },
        } as unknown as BuildStudioResult['orchestrator'],
      };
    },
  });

  await handler.handleStudioRequest(peer, {
    type: 'studio_request',
    requestId: 'studio-1',
    runId: 'run-100',
    conversationId: 'conv-100',
    userRequest: 'plan this',
  }, createDeps());

  assert.equal(buildInputs.length, 1);
  assert.deepEqual(buildInputs[0]?.capabilities.map((item) => item.name), ['browser', 'user-capability']);
  assert.deepEqual(buildInputs[0]?.toolkits?.map((item) => item.name), ['plugin-toolkit', 'local-toolkit']);
  assert.equal(buildInputs[0]?.bridge.requestId, 'studio-1');
  assert.equal(buildInputs[0]?.workdir, '/tmp/pinpawo-test');
  assert.equal(buildInputs[0]?.studioConfigPath, '/tmp/pinpawo-test/.pinpawo/studio.json');
  assert.equal(buildInputs[0]?.petsDir, '/tmp/pinpawo-test/.pinpawo/pets');
  assert.equal(buildInputs[0]?.wikiBaseDir, '/tmp/pinpawo-test/.pinpawo/studio-wiki');

  const eventMessages = sent.filter((item): item is { type: string; event?: { type?: string; phase?: string } } =>
    Boolean(item && typeof item === 'object' && (item as { type?: unknown }).type === 'event'),
  );
  assert.deepEqual(eventMessages.map((item) => item.event?.type), [
    'studio.progress',
  ]);
  assert.deepEqual(sent.at(-1), {
    type: 'studio_response',
    requestId: 'studio-1',
    outcome: 'done',
    reply: 'done reply',
    finalPetRunId: 'pet-run-1',
    workdir: '/tmp/pinpawo-test',
    runId: 'run-100',
    conversationId: 'conv-100',
    idempotencyKey: 'studio:conv-100:run:run-100',
  });
});

test('LocalServerStudioHandler serializes studio requests per peer', async () => {
  const sent: unknown[] = [];
  const peer = createFakePeer(sent);
  const firstStarted = deferred<void>();
  const firstContinue = deferred<void>();
  const invocationEvents: string[] = [];
  const handler = new LocalServerStudioHandler({
    reviewRouter: new LocalServerStudioReviewRouter<LocalServerPeer>(),
    inflightRequests: createInflightController(),
    outbound: PEER_OUTBOUND,
    buildStudio: async () => ({
      resolved: {} as BuildStudioResult['resolved'],
      orchestrator: {
        submitRequest: async () => {
          if (invocationEvents.length === 0) {
            invocationEvents.push('first');
            firstStarted.resolve();
            return { runId: 'first-run', status: 'accepted' };
          }
          invocationEvents.push('second');
          return { runId: 'second-run', status: 'accepted' };
        },
        waitForRun: async (runId: string) => {
          if (runId === 'first-run') {
            await firstContinue.promise;
            return {
              outcome: {
                outcome: 'done',
                reply: 'first done',
                finalPetRunId: 'pet-run-first',
              },
            };
          }
          return {
              outcome: {
                outcome: 'done',
                reply: 'second done',
                finalPetRunId: 'pet-run-second',
              },
          };
        },
      } as unknown as BuildStudioResult['orchestrator'],
    }),
  });

  const firstRequest = handler.handleStudioRequest(peer, {
    type: 'studio_request',
    requestId: 'studio-1',
    userRequest: 'first',
  }, createDeps());
  await firstStarted.promise;

  const secondRequest = handler.handleStudioRequest(peer, {
    type: 'studio_request',
    requestId: 'studio-2',
    userRequest: 'second',
  }, createDeps());

  await sleep(10);
  assert.equal(invocationEvents.length, 1);
  assert.equal(invocationEvents[0], 'first');

  firstContinue.resolve();
  await Promise.all([firstRequest, secondRequest]);

  assert.equal(invocationEvents.length, 2);
  assert.deepEqual(invocationEvents, ['first', 'second']);

  const types = sent.map((item) => (item as { type?: string }).type).filter(Boolean);
  assert.equal(types.includes('interrupted'), false);

  const errors = sent.filter((item): item is { type: 'studio_error'; requestId: string; message: string } => (
    Boolean(item && typeof item === 'object' && (item as { type: string }).type === 'studio_error')
  ));
  assert.deepEqual(errors, []);

  const studioResponses = sent.filter((item): item is { type: 'studio_response'; requestId: string } => (
    Boolean(item && typeof item === 'object' && (item as { type: string }).type === 'studio_response')
  ));
  assert.equal(studioResponses.length, 2);
  assert.equal(studioResponses[0]?.requestId, 'studio-1');
  assert.equal(studioResponses[1]?.requestId, 'studio-2');
});

test('LocalServerStudioHandler discards queued studio requests after peer disconnect', async () => {
  const sent: unknown[] = [];
  const peer = createFakePeer(sent);
  const firstStarted = deferred<void>();
  const firstContinue = deferred<void>();
  const invocationEvents: string[] = [];
  const handler = new LocalServerStudioHandler({
    reviewRouter: new LocalServerStudioReviewRouter<LocalServerPeer>(),
    inflightRequests: createInflightController(),
    outbound: PEER_OUTBOUND,
    buildStudio: async () => ({
      resolved: {} as BuildStudioResult['resolved'],
      orchestrator: {
        submitRequest: async () => {
          if (invocationEvents.length === 0) {
            invocationEvents.push('first');
            firstStarted.resolve();
            return { runId: 'first-run', status: 'accepted' };
          }
          invocationEvents.push('second');
          return { runId: 'second-run', status: 'accepted' };
        },
        waitForRun: async (runId: string) => {
          if (runId === 'first-run') {
            await firstContinue.promise;
            return {
              outcome: {
                outcome: 'done',
                reply: 'first done',
                finalPetRunId: 'pet-run-first',
              },
            };
          }
          return {
              outcome: {
                outcome: 'done',
                reply: 'second done',
                finalPetRunId: 'pet-run-second',
              },
          };
        },
      } as unknown as BuildStudioResult['orchestrator'],
    }),
  });

  const firstRequest = handler.handleStudioRequest(peer, {
    type: 'studio_request',
    requestId: 'studio-1',
    userRequest: 'first',
  }, createDeps());
  await firstStarted.promise;

  const secondRequest = handler.handleStudioRequest(peer, {
    type: 'studio_request',
    requestId: 'studio-2',
    userRequest: 'second',
  }, createDeps());

  handler.rejectDisconnected(peer);
  firstContinue.resolve();

  await Promise.all([firstRequest, secondRequest]);

  assert.deepEqual(invocationEvents, ['first']);

  const studioResponses = sent.filter((item): item is { type: 'studio_response'; requestId: string } => (
    Boolean(item && typeof item === 'object' && (item as { type: string }).type === 'studio_response')
  ));
  assert.equal(studioResponses.length, 1);
  assert.equal(studioResponses[0]?.requestId, 'studio-1');
});

test('LocalServerStudioHandler maps missing studio config to studio_error', async () => {
  const sent: unknown[] = [];
  const peer = createFakePeer(sent);
  const handler = new LocalServerStudioHandler({
    reviewRouter: new LocalServerStudioReviewRouter<LocalServerPeer>(),
    inflightRequests: createInflightController(),
    outbound: PEER_OUTBOUND,
    buildStudio: async () => {
      throw new StudioNotConfiguredError('/tmp/studio.json');
    },
  });

  await handler.handleStudioRequest(peer, {
    type: 'studio_request',
    requestId: 'studio-2',
    userRequest: 'plan this',
  }, createDeps());

  assert.deepEqual(sent, [{
    type: 'studio_error',
    requestId: 'studio-2',
    message: 'Studio 未配置:No Studio config found at /tmp/studio.json. Create one to enable /studio.',
  }]);
});

test('LocalServerStudioHandler fills runId and conversationId defaults', async () => {
  const sent: unknown[] = [];
  const peer = createFakePeer(sent);
  const buildInputs: BuildStudioInput[] = [];
  const handler = new LocalServerStudioHandler({
    reviewRouter: new LocalServerStudioReviewRouter<LocalServerPeer>(),
    inflightRequests: createInflightController(),
    outbound: PEER_OUTBOUND,
    buildStudio: async (input) => {
      buildInputs.push(input);
      return {
        resolved: {} as BuildStudioResult['resolved'],
        orchestrator: {
          submitRequest: async () => ({ runId: 'studio-default', status: 'accepted' }),
          waitForRun: async () => ({
            outcome: {
              outcome: 'done',
              reply: 'done reply',
              finalPetRunId: 'pet-run-default',
            },
          }),
        } as unknown as BuildStudioResult['orchestrator'],
      };
    },
  });

  await handler.handleStudioRequest(peer, {
    type: 'studio_request',
    requestId: 'studio-default',
    userRequest: 'plan default ids',
  }, createDeps());

  const response = sent.find((item): item is {
    type: 'studio_response';
    requestId: string;
    runId?: string;
    conversationId?: string;
    finalPetRunId: string;
  } => (
    Boolean(item && typeof item === 'object' && (item as { type: string }).type === 'studio_response')
  ));
  assert.ok(response);
  assert.equal(response.requestId, 'studio-default');
  assert.equal(response.runId, 'studio-default');
  assert.equal(response.conversationId, 'studio-default');
  assert.equal(response.finalPetRunId, 'pet-run-default');
});
