import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  AIMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import {
  CliRenderEvents,
  type CliRenderer,
} from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import type {
  AgentSession,
  AgentTimelineEntry,
} from '@pinpawo/agent-session';
import type {
  AgentChannelSetup,
} from '../../local-agent/src/agentChannel';
import {
  FileCapabilityArtifactStore,
} from '../../local-agent/src/capabilityArtifactStore';
import {
  buildLocalOnlyAgentContext,
} from '../../local-agent/src/contextLoader';
import type {
  LocalAgentGraphService,
} from '../../local-agent/src/agentGraphService';
import {
  createLocalServerHandlers,
} from '../../local-agent/src/localServerHandlers';
import type {
  LocalServerPeerHandlers,
} from '../../local-agent/src/localServerMessageDispatcher';
import {
  attachLocalServerWebSocketTransport,
} from '../../local-agent/src/localServerWsTransport';
import {
  buildLocalAgentRuntimeConfig,
} from '../../local-agent/src/runtimeConfig';
import {
  createBashToolkit,
  createGitToolkit,
} from '../../local-agent/src/toolkits/local/index';
import {
  LocalHostConnection,
} from '../src/client/localHostConnection';
import { TuiSessionController } from '../src/session/sessionController';
import { TimelineScrollback } from '../src/timeline/timelineScrollback';

const AUTH_TOKEN = 'tui-v2-host-integration-token';
const USER_MESSAGE = 'Inspect the host integration.';
const ASSISTANT_MESSAGE = '# Result\n\nThe **host transport** is aligned.';
const REQUIRED_TOOLKITS = [createBashToolkit(), createGitToolkit()];

test('production local-agent handlers drive ordered v2 scrollback and reconnect', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'pinpawo-tui-v2-host-'));
  const runtimeConfig = buildLocalAgentRuntimeConfig(workdir);
  const graphFixture = createGraphFixture();
  const localServerHandlers = createLocalServerHandlers({
    actorId: 'pet-host-integration',
    actorName: 'PinPawo',
    workdir,
    runtimeConfig,
    llmConfig: {
      apiKey: 'offline-integration-key',
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'host-integration-model',
      contextWindowTokens: 32_000,
    },
    localToolkitDefinitions: REQUIRED_TOOLKITS,
    localToolkits: REQUIRED_TOOLKITS,
    capabilityArtifactStore: new FileCapabilityArtifactStore(
      runtimeConfig.capabilityArtifactRoot,
    ),
  }, {
    chatGraphService: graphFixture.service,
    loadContext: async (actorId) => buildLocalOnlyAgentContext(actorId),
  });

  const server = createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  let snapshotRequestCount = 0;
  let chatRequestCount = 0;
  const transportErrors: unknown[] = [];
  const transportLogs: string[] = [];
  const productionHandlers = localServerHandlers.peerHandlers;
  const peerHandlers: LocalServerPeerHandlers = {
    ...productionHandlers,
    onChatRequest: (peer, message) => {
      chatRequestCount += 1;
      return productionHandlers.onChatRequest(peer, message);
    },
    onSessionSnapshotGet: (peer, message) => {
      snapshotRequestCount += 1;
      return productionHandlers.onSessionSnapshotGet(peer, message);
    },
    log: (message) => {
      transportLogs.push(message);
    },
    logError: (_message, error) => {
      transportErrors.push(error);
    },
    logWarn: () => undefined,
  };
  const webSocketServer = attachLocalServerWebSocketTransport(
    server,
    peerHandlers,
    {
      authToken: AUTH_TOKEN,
      port: address.port,
    },
  );

  const rendererSetup = await createTestRenderer({
    width: 64,
    height: 24,
    screenMode: 'split-footer',
    footerHeight: 9,
    externalOutputMode: 'capture-stdout',
  });
  const committedRows = captureCommittedRows(rendererSetup.renderer);
  const timeline = new TimelineScrollback(rendererSetup.renderer);
  const requestIds = [
    'snapshot-startup',
    'chat-request',
    'snapshot-completion',
    'snapshot-reconnect',
  ];
  const observedSessions: AgentSession[] = [];
  const observedConnections: string[] = [];
  const controller = new TuiSessionController({
    connectionFactory: (connectionHandlers) => new LocalHostConnection(
      connectionHandlers,
      {
        port: address.port,
        tokenProvider: () => AUTH_TOKEN,
      },
    ),
    requestIdFactory: () => requestIds.shift() ?? 'unexpected-request',
    reconnectDelaysMs: [10],
    snapshotTimeoutMs: 1_000,
  });
  const unsubscribe = controller.subscribe((state) => {
    observedConnections.push(state.connection);
    observedSessions.push(state.session);
    timeline.render(state.session);
  });

  try {
    controller.start();
    try {
      await waitFor(() => controller.getState().connection === 'ready');
    } catch (error) {
      throw new Error([
        error instanceof Error ? error.message : String(error),
        `state=${JSON.stringify(controller.getState())}`,
        `logs=${JSON.stringify(transportLogs)}`,
        `errors=${JSON.stringify(transportErrors)}`,
        `snapshotRequests=${snapshotRequestCount}`,
      ].join('\n'));
    }

    assert.deepEqual(controller.submitChat(USER_MESSAGE), {
      ok: true,
      requestId: 'chat-request',
    });
    await waitFor(() => (
      snapshotRequestCount === 2
      && controller.getState().session.activeRun === null
      && controller.getState().session.timeline.some((entry) => (
        entry.type === 'message'
        && entry.role === 'assistant'
        && entry.status === 'completed'
      ))
    ));
    // The production renderer remains alive after a response. Give OpenTUI's
    // asynchronous Markdown highlighter the same settlement window before
    // this short-lived integration renderer is destroyed.
    await Bun.sleep(200);

    assert.equal(chatRequestCount, 1);
    assert.equal(graphFixture.streamCount(), 1);
    assert.deepEqual(transportErrors, []);
    assert.equal(controller.getState().connection, 'ready');
    assert.equal(controller.getState().session.runtime?.model, 'host-integration-model');
    assert.deepEqual(
      controller.getState().session.sessionTokenUsage
        ? {
            inputTokens: controller.getState().session.sessionTokenUsage?.inputTokens,
            outputTokens: controller.getState().session.sessionTokenUsage?.outputTokens,
            totalTokens: controller.getState().session.sessionTokenUsage?.totalTokens,
            scope: controller.getState().session.sessionTokenUsage?.scope,
          }
        : null,
      {
        inputTokens: 20,
        outputTokens: 8,
        totalTokens: 28,
        scope: 'session',
      },
    );
    assert.deepEqual(
      controller.getState().session.timeline.map(timelineEntryShape),
      [
        'message:user:completed',
        'operation:runtime.read_fixture:completed',
        'message:subagent:completed',
        'message:assistant:completed',
      ],
    );
    assert.ok(observedSessions.some((session) => session.timeline.some((entry) => (
      entry.type === 'operation' && entry.phase === 'started'
    ))));
    assert.ok(observedSessions.some((session) => session.timeline.some((entry) => (
      entry.type === 'message'
      && entry.role === 'assistant'
      && entry.status === 'streaming'
    ))));

    const output = committedRows.join('\n');
    assertOrdered(output, [
      USER_MESSAGE,
      'read_fixture',
      'host output',
      'Found transport evidence.',
      'Result',
      'The host transport is aligned.',
    ]);
    assert.doesNotMatch(output, /# Result|\*\*host transport\*\*/);
    assert.equal(countOccurrences(output, USER_MESSAGE), 1);
    assert.equal(countOccurrences(output, 'The host transport is aligned.'), 1);

    for (const client of webSocketServer.clients) {
      client.terminate();
    }
    try {
      await waitFor(() => (
        snapshotRequestCount === 3
        && controller.getState().connection === 'ready'
        && controller.getState().session.timeline.length === 2
      ));
    } catch (error) {
      throw new Error([
        error instanceof Error ? error.message : String(error),
        `state=${JSON.stringify(controller.getState())}`,
        `connections=${JSON.stringify(observedConnections)}`,
        `logs=${JSON.stringify(transportLogs)}`,
        `errors=${JSON.stringify(transportErrors)}`,
        `snapshotRequests=${snapshotRequestCount}`,
      ].join('\n'));
    }
    assert.ok(observedConnections.includes('reconnecting'));
    assert.deepEqual(
      controller.getState().session.timeline.map(timelineEntryShape),
      [
        'message:user:completed',
        'message:assistant:completed',
      ],
    );
    assert.equal(
      committedRows.join('\n'),
      output,
      'checkpoint rehydration must not replay committed terminal rows',
    );
    assert.ok(
      transportLogs.filter((message) => (
        message === '[local-server] TUI client connected'
      )).length >= 2,
    );
  } finally {
    unsubscribe();
    controller.stop();
    timeline.destroy();
    rendererSetup.renderer.destroy();
    for (const client of webSocketServer.clients) {
      client.terminate();
    }
    await Bun.sleep(10);
    await closeWebSocketServer(webSocketServer);
    await closeServer(server);
    localServerHandlers.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});

function createGraphFixture() {
  let messages: BaseMessage[] = [];
  let streams = 0;
  const service = {
    async readThreadState() {
      return {
        messages,
        pendingHumanReview: null,
        hasPendingContinuation: false,
      };
    },
    streamEvents(setup: AgentChannelSetup) {
      streams += 1;
      const finalReply = new AIMessage({
        content: ASSISTANT_MESSAGE,
        usage_metadata: {
          input_tokens: 20,
          output_tokens: 8,
          total_tokens: 28,
        },
      });
      finalReply.id = 'assistant-final';
      messages = [...setup.input.messages, finalReply];
      return (async function* () {
        const toolNamespace = ['general:host', 'tools:read'];
        yield protocolEvent('tools', {
          event: 'tool-started',
          tool_call_id: 'operation-1',
          tool_name: 'read_fixture',
          input: { path: 'services/tui' },
        }, toolNamespace);

        const subagentNamespace = ['general:host', 'model_request:explore'];
        yield protocolEvent('messages', {
          event: 'message-start',
          id: 'subagent-1',
        }, subagentNamespace);
        yield protocolEvent('messages', {
          event: 'content-block-delta',
          delta: {
            type: 'text-delta',
            text: 'Found transport evidence.',
          },
        }, subagentNamespace);
        yield protocolEvent('messages', {
          event: 'message-finish',
        }, subagentNamespace);

        yield protocolEvent('tools', {
          event: 'tool-finished',
          tool_call_id: 'operation-1',
          output: 'host output',
        }, toolNamespace);

        yield protocolEvent('messages', {
          event: 'message-start',
          id: 'assistant-final',
        });
        yield protocolEvent('messages', {
          event: 'content-block-delta',
          delta: {
            type: 'text-delta',
            text: ASSISTANT_MESSAGE,
          },
        });
        yield protocolEvent('messages', {
          event: 'message-finish',
        });
        yield protocolEvent('values', { messages });
      })();
    },
  } as unknown as LocalAgentGraphService;

  return {
    service,
    streamCount: () => streams,
  };
}

function protocolEvent(
  method: string,
  data: unknown,
  namespace: string[] = [],
) {
  return {
    type: 'event' as const,
    seq: 0,
    method,
    params: {
      namespace,
      data,
    },
  };
}

function timelineEntryShape(entry: AgentTimelineEntry) {
  return entry.type === 'operation'
    ? `operation:${entry.kind}:${entry.phase}`
    : `message:${entry.role}:${entry.status}`;
}

function captureCommittedRows(renderer: CliRenderer) {
  const rows: string[] = [];
  const decoder = new TextDecoder();
  renderer.on(CliRenderEvents.EXTERNAL_OUTPUT, (event) => {
    const bytes = event.snapshot.getRealCharBytes(true);
    const rowWidth = event.snapshot.width * 4;
    for (let row = 0; row < event.snapshot.height; row += 1) {
      rows.push(
        decoder
          .decode(bytes.subarray(row * rowWidth, (row + 1) * rowWidth))
          .trimEnd(),
      );
    }
  });
  return rows;
}

function assertOrdered(text: string, parts: readonly string[]) {
  let cursor = -1;
  for (const part of parts) {
    const index = text.indexOf(part, cursor + 1);
    assert.ok(index > cursor, `expected "${part}" after offset ${cursor}\n${text}`);
    cursor = index;
  }
}

function countOccurrences(text: string, value: string) {
  return text.split(value).length - 1;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`condition was not met within ${timeoutMs}ms`);
    }
    await Bun.sleep(5);
  }
}

async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function closeWebSocketServer(
  server: ReturnType<typeof attachLocalServerWebSocketTransport>,
) {
  await withCleanupTimeout(
    new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    }),
    'WebSocket server',
  );
}

async function closeServer(server: ReturnType<typeof createServer>) {
  if (!server.listening) {
    return;
  }
  server.closeAllConnections();
  await withCleanupTimeout(
    new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (
          error
          && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
        ) {
          reject(error);
          return;
        }
        resolve();
      });
    }),
    'HTTP server',
  );
}

async function withCleanupTimeout(
  cleanup: Promise<void>,
  label: string,
) {
  await Promise.race([
    cleanup,
    Bun.sleep(250).then(() => {
      throw new Error(`${label} did not close within 250ms`);
    }),
  ]);
}
