import assert from 'node:assert/strict';
import test from 'node:test';
import type { WebSocket } from 'ws';
import {
  sendLocalAgentEvent,
  sendLocalAgentMessage,
} from './localAgentProtocol';
import { InflightRequestController } from './inflightRequestController';
import { LocalServerStudioHandler } from './localServerStudioHandler';
import { LocalServerStudioReviewRouter } from './localServerStudioReviews';
import { StudioNotConfiguredError, type BuildStudioInput, type BuildStudioResult } from './studio/studioRuntime';
import type { LocalServerDeps } from './localServerTypes';

function createFakeWebSocket(sent: unknown[]) {
  return {
    readyState: 1,
    send(data: string) {
      sent.push(JSON.parse(data) as unknown);
    },
  } as unknown as WebSocket;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolveFn) => {
    resolve = resolveFn;
  });
  return { promise, resolve };
}

function createInflightController() {
  return new InflightRequestController<WebSocket>({
    forceInterruptMs: 1,
    emitOperation: (ws, event) => sendLocalAgentEvent(ws, event),
    sendControl: (ws, message) => sendLocalAgentMessage(ws, message),
    log: () => undefined,
  });
}

function createDeps(): LocalServerDeps {
  return {
    actorId: 'pet-a',
    actorName: 'Pet A',
    llmConfig: {
      provider: 'openai',
      model: 'test-model',
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
    } as unknown as LocalServerDeps['llmConfig'],
    workdir: '/tmp/pinpawo-test',
    runtimeConfig: {
      workdir: '/tmp/pinpawo-test',
      stateRoot: '/tmp/pinpawo-test/.pinpawo',
      studioConfigPath: '/tmp/pinpawo-test/.pinpawo/studio.json',
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
        operations: {
          read_file: {
            title: '读文件',
            summarizeInput: (input: unknown) => {
            const path = input && typeof input === 'object' && 'path' in input
              ? (input as { path?: unknown }).path
              : null;
            return typeof path === 'string' ? { target: path } : null;
          },
        },
      },
    }] as LocalServerDeps['localToolkits'],
    pluginToolkits: [{ name: 'plugin-toolkit' }] as LocalServerDeps['pluginToolkits'],
    localCapabilities: [{ name: 'browser' }] as LocalServerDeps['localCapabilities'],
    userCapabilities: [{
      meta: { id: 'user-cap' },
      capability: { name: 'user-capability' },
    }] as LocalServerDeps['userCapabilities'],
  };
}

test('LocalServerStudioHandler emits progress, operations, and done response', async () => {
  const sent: unknown[] = [];
  const ws = createFakeWebSocket(sent);
  const buildInputs: BuildStudioInput[] = [];
  const handler = new LocalServerStudioHandler({
    reviewRouter: new LocalServerStudioReviewRouter<WebSocket>(),
    inflightRequests: createInflightController(),
    buildStudio: async (input) => {
      buildInputs.push(input);
      return {
        resolved: {} as BuildStudioResult['resolved'],
        orchestrator: {
          invoke: async (turn: {
            onTurnEvent: (event: Record<string, unknown>) => void;
            onToolEvent: (event: unknown) => void;
          }) => {
            turn.onTurnEvent({ type: 'turn_started' });
            turn.onToolEvent({
              event: 'on_tool_start',
              name: 'read_file',
              input: { path: 'README.md' },
            });
            return {
              outcome: {
                outcome: 'done',
                reply: 'done reply',
                finalDispatchId: 'dispatch-1',
              },
            };
          },
        } as unknown as BuildStudioResult['orchestrator'],
      };
    },
  });

  await handler.handleStudioRequest(ws, {
    type: 'studio_request',
    requestId: 'studio-1',
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
    'operation',
    'operation',
  ]);
  assert.deepEqual(eventMessages.map((item) => item.event?.phase).filter(Boolean), ['started', 'completed']);
  assert.deepEqual(sent.at(-1), {
    type: 'studio_response',
    requestId: 'studio-1',
    outcome: 'done',
    reply: 'done reply',
    finalDispatchId: 'dispatch-1',
  });
});

test('LocalServerStudioHandler interrupts previous studio request on the same websocket', async () => {
  const sent: unknown[] = [];
  const ws = createFakeWebSocket(sent);
  const firstStarted = deferred<void>();
  const firstAborted = deferred<boolean>();
  let invocationCount = 0;

  const handler = new LocalServerStudioHandler({
    reviewRouter: new LocalServerStudioReviewRouter<WebSocket>(),
    inflightRequests: createInflightController(),
    buildStudio: async () => ({
      resolved: {} as BuildStudioResult['resolved'],
      orchestrator: {
        invoke: async (turn: {
          onTurnEvent: (event: Record<string, unknown>) => void;
          onToolEvent: (event: unknown) => void;
          signal?: AbortSignal;
        }) => {
          invocationCount += 1;
          if (invocationCount === 1) {
            firstStarted.resolve();
            turn.signal?.addEventListener('abort', () => {
              firstAborted.resolve(turn.signal?.aborted ?? false);
            }, { once: true });
            await firstAborted.promise;
            return {
              outcome: {
                outcome: 'done',
                reply: 'first done',
                finalDispatchId: 'dispatch-first',
              },
            };
          }
          return {
            outcome: {
              outcome: 'done',
              reply: 'second done',
              finalDispatchId: 'dispatch-second',
            },
          };
        },
      } as unknown as BuildStudioResult['orchestrator'],
    }),
  });

  const firstRequest = handler.handleStudioRequest(ws, {
    type: 'studio_request',
    requestId: 'studio-1',
    userRequest: 'first',
  }, createDeps());
  await firstStarted.promise;

  await handler.handleStudioRequest(ws, {
    type: 'studio_request',
    requestId: 'studio-2',
    userRequest: 'second',
  }, createDeps());
  await firstRequest;

  assert.equal(invocationCount, 2);
  assert.equal(await firstAborted.promise, true);

  const types = sent.map((item) => (item as { type?: string }).type).filter(Boolean);
  assert.equal(types.includes('interrupted'), true);

  const errors = sent.filter((item): item is { type: 'studio_error'; requestId: string; message: string } => (
    Boolean(item && typeof item === 'object' && (item as { type: string }).type === 'studio_error')
  ));
  assert.deepEqual(errors, [{
    type: 'studio_error',
    requestId: 'studio-1',
    message: 'aborted by client',
  }]);

  const studioResponses = sent.filter((item): item is { type: 'studio_response'; requestId: string } => (
    Boolean(item && typeof item === 'object' && (item as { type: string }).type === 'studio_response')
  ));
  assert.equal(studioResponses.length, 1);
  assert.equal(studioResponses[0]?.requestId, 'studio-2');
});

test('LocalServerStudioHandler maps missing studio config to studio_error', async () => {
  const sent: unknown[] = [];
  const ws = createFakeWebSocket(sent);
  const handler = new LocalServerStudioHandler({
    reviewRouter: new LocalServerStudioReviewRouter<WebSocket>(),
    inflightRequests: createInflightController(),
    buildStudio: async () => {
      throw new StudioNotConfiguredError('/tmp/studio.json');
    },
  });

  await handler.handleStudioRequest(ws, {
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
