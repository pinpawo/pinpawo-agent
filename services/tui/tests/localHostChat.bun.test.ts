import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  CliRenderEvents,
  type CliRenderer,
} from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import type {
  AgentSession,
  AgentTimelineEntry,
} from '@pinpawo/agent-session';
import {
  FileCapabilityArtifactStore,
} from '../../local-agent/src/capabilityArtifactStore';
import {
  buildAgentContext,
} from '../../local-agent/src/contextLoader';
import {
  readLocalChatDisplayText,
} from '../../local-agent/src/localChatAttachments';
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
  createTestModelServerDeps,
} from '../../local-agent/src/testing/modelProfiles';
import {
  createTestHostToolkitInventory,
} from '../../local-agent/src/testing/toolkitInventory';
import {
  createBashToolkit,
  createGitToolkit,
} from '../../local-agent/src/toolkits/local/index';
import {
  LocalHostConnection,
} from '../src/client/localHostConnection';
import { TuiSessionController } from '../src/session/sessionController';
import { TimelineScrollback } from '../src/timeline/timelineScrollback';
import {
  ASSISTANT_MESSAGE,
  createHostGraphFixture,
  ERROR_MESSAGE,
  ERROR_PARTIAL,
  GRAPH_ERROR,
  INTERRUPT_MESSAGE,
  INTERRUPT_PARTIAL,
  REVIEW_APPROVE_MESSAGE,
  REVIEW_APPROVED_REPLY,
  REVIEW_CANCEL_MESSAGE,
  REVIEW_CONTINUE_GUIDANCE,
  REVIEW_SPEC,
} from './support/hostGraphFixture';

const AUTH_TOKEN = 'tui-v2-host-integration-token';
const USER_MESSAGE = 'Inspect the host integration.';
const RECOVERY_MESSAGE = 'Verify the host recovers.';
const ATTACHMENT_NAME = '资料 with spaces.txt';
const ATTACHMENT_CONTENT = 'fixture contents must remain unread until a tool inspects this path';
const REQUIRED_TOOLKITS = [createBashToolkit(), createGitToolkit()];

test('production local-agent handlers drive the v2 host vertical slice', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'pinpawo-tui-v2-host-'));
  const attachmentPath = join(workdir, ATTACHMENT_NAME);
  writeFileSync(attachmentPath, ATTACHMENT_CONTENT);
  const runtimeConfig = buildLocalAgentRuntimeConfig(workdir);
  const graphFixture = createHostGraphFixture();
  const localServerHandlers = createLocalServerHandlers({
    serverMode: 'chat',
    actorId: 'pet-host-integration',
    actorName: 'PinPawo',
    workdir,
    runtimeConfig,
    ...createTestModelServerDeps({
      apiKey: 'offline-integration-key',
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'host-integration-model',
      contextWindowTokens: 32_000,
    }),
    toolkitInventory: createTestHostToolkitInventory(REQUIRED_TOOLKITS),
    capabilityArtifactStore: new FileCapabilityArtifactStore(
      runtimeConfig.capabilityArtifactRoot,
    ),
  }, {
    chatGraphService: graphFixture.service,
    loadContext: async (actorId) => buildAgentContext(actorId),
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
    'session-new',
    'session-list',
    'session-resume',
    'chat-interrupt',
    'snapshot-interrupt',
    'chat-review-approve',
    'snapshot-review-approve',
    'chat-review-cancel',
    'snapshot-review-cancel',
    'chat-review-continue',
    'snapshot-review-continue',
    'chat-error',
    'snapshot-error',
    'chat-recovery',
    'snapshot-recovery',
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

    assert.deepEqual(controller.submitChat(USER_MESSAGE, [{
      id: 'attachment-1',
      source: 'local-path',
      kind: 'file',
      path: attachmentPath,
      name: ATTACHMENT_NAME,
    }]), {
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
    const graphInputMessage = graphFixture.inputMessages().at(-1);
    assert.ok(graphInputMessage);
    const graphInputText = graphInputMessage.content;
    if (typeof graphInputText !== 'string') {
      assert.fail('expected the local attachment model input to be text');
    }
    assert.match(graphInputText, /<local_attachments>/);
    assert.ok(graphInputText.includes(attachmentPath));
    assert.ok(!graphInputText.includes(ATTACHMENT_CONTENT));
    assert.equal(
      readLocalChatDisplayText(graphInputMessage),
      `${USER_MESSAGE}\n\nAttachments:\n- file: ${ATTACHMENT_NAME}`,
    );
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
    const visibleUserMessage = controller.getState().session.timeline.find((entry) => (
      entry.type === 'message' && entry.role === 'user'
    ));
    assert.equal(
      visibleUserMessage?.type === 'message' ? visibleUserMessage.text : null,
      `${USER_MESSAGE}\n\nAttachments:\n- file: ${ATTACHMENT_NAME}`,
    );
    assert.doesNotMatch(
      visibleUserMessage?.type === 'message' ? visibleUserMessage.text : '',
      new RegExp(escapeRegExp(attachmentPath)),
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
      ATTACHMENT_NAME,
      'read_fixture',
      'host output',
      'Found transport evidence.',
      'Result',
      'The host transport is aligned.',
    ]);
    assert.doesNotMatch(output, /# Result|\*\*host transport\*\*/);
    assert.doesNotMatch(output, new RegExp(escapeRegExp(attachmentPath)));
    assert.doesNotMatch(output, new RegExp(escapeRegExp(ATTACHMENT_CONTENT)));
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
    const checkpointUserMessage = controller.getState().session.timeline.find((entry) => (
      entry.type === 'message' && entry.role === 'user'
    ));
    assert.equal(
      checkpointUserMessage?.type === 'message' ? checkpointUserMessage.text : null,
      `${USER_MESSAGE}\n\nAttachments:\n- file: ${ATTACHMENT_NAME}`,
    );
    assert.doesNotMatch(
      checkpointUserMessage?.type === 'message' ? checkpointUserMessage.text : '',
      new RegExp(escapeRegExp(attachmentPath)),
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

    const originalSessionId = controller.getState().session.sessionId;
    const committedBeforeSessionSwitch = committedRows.join('\n');
    const newSession = await controller.startNewSession();
    assert.notEqual(newSession.session.id, originalSessionId);
    assert.equal(newSession.session.active, true);
    assert.equal(controller.getState().session.sessionId, newSession.session.id);
    assert.deepEqual(controller.getState().session.timeline, []);
    const committedAfterNewSession = committedRows.join('\n');
    assert.ok(committedAfterNewSession.startsWith(committedBeforeSessionSwitch));
    assert.match(
      committedAfterNewSession.slice(committedBeforeSessionSwitch.length),
      /── session .* ──/,
    );
    assert.equal(countOccurrences(committedAfterNewSession, USER_MESSAGE), 1);
    assert.equal(
      countOccurrences(committedAfterNewSession, 'The host transport is aligned.'),
      1,
    );

    const sessions = await controller.listSessions();
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0]?.id, newSession.session.id);
    assert.equal(sessions[0]?.active, true);
    const originalSession = sessions.find((session) => session.id === originalSessionId);
    assert.ok(originalSession);
    assert.equal(originalSession.active, false);
    assert.match(originalSession.title, /Inspect the host integration/);

    const resumedSession = await controller.resumeSession(originalSessionId);
    assert.equal(resumedSession.session.id, originalSessionId);
    assert.equal(resumedSession.session.active, true);
    assert.equal(controller.getState().session.sessionId, originalSessionId);
    assert.deepEqual(
      controller.getState().session.timeline.map(timelineEntryShape),
      [
        'message:user:completed',
        'message:assistant:completed',
      ],
    );
    await Bun.sleep(200);
    const resumedOutput = committedRows.join('\n');
    assert.equal(countOccurrences(resumedOutput, USER_MESSAGE), 2);
    assert.equal(countOccurrences(resumedOutput, 'The host transport is aligned.'), 2);
    assert.doesNotMatch(resumedOutput, new RegExp(escapeRegExp(attachmentPath)));

    assert.deepEqual(controller.submitChat(INTERRUPT_MESSAGE), {
      ok: true,
      requestId: 'chat-interrupt',
    });
    await waitFor(() => {
      const run = controller.getState().session.activeRun;
      return run?.state === 'running' && run.activity === 'streaming';
    });
    assert.deepEqual(controller.interruptRun(), {
      ok: true,
      requestId: 'chat-interrupt',
    });
    assert.equal(controller.getState().session.activeRun?.state, 'interrupting');
    await waitFor(() => (
      graphFixture.interruptObserved()
      && controller.getState().session.activeRun === null
    ));
    const interruptedEntries = controller.getState().session.timeline.filter(
      (entry): entry is Extract<AgentTimelineEntry, { type: 'message' }> => (
        entry.type === 'message' && entry.requestId === 'chat-interrupt'
      ),
    );
    assert.deepEqual(
      interruptedEntries.map((entry) => `${entry.role}:${entry.status}:${entry.text}`),
      [
        `user:completed:${INTERRUPT_MESSAGE}`,
        `assistant:completed:${INTERRUPT_PARTIAL}`,
        'system:completed:interrupted',
      ],
    );
    const interruptedOutput = committedRows.join('\n');
    assertOrdered(interruptedOutput.slice(resumedOutput.length), [
      INTERRUPT_MESSAGE,
      INTERRUPT_PARTIAL,
      'interrupted',
    ]);
    assert.equal(snapshotRequestCount, 4);

    assert.deepEqual(controller.submitChat(REVIEW_APPROVE_MESSAGE), {
      ok: true,
      requestId: 'chat-review-approve',
    });
    await waitFor(() => (
      controller.getState().session.activeRun?.state === 'pending_interrupt'
    ));
    const approvalRun = controller.getState().session.activeRun;
    assert.ok(approvalRun?.state === 'pending_interrupt');
    assert.equal(approvalRun.pendingInterrupt.interruptId, 'review-interrupt-approve');
    assert.equal(approvalRun.pendingInterrupt.payload.interactions[0]?.interactionId, REVIEW_SPEC.id);
    const approvalResult = controller.submitReviewResponse({
      requestId: 'chat-review-approve',
      interruptId: approvalRun.pendingInterrupt.interruptId,
      decisions: [],
      optionId: 'approve',
    });
    assert.equal(approvalResult.ok, true);
    assert.equal(approvalResult.ok ? approvalResult.status : null, 'sent');
    await waitFor(() => (
      snapshotRequestCount === 5
      && controller.getState().session.activeRun === null
      && hasCompletedRequestMessage(
        controller.getState().session,
        'chat-review-approve',
        REVIEW_APPROVED_REPLY,
      )
    ));
    assert.deepEqual(graphFixture.reviewResumes()[0], {
      'review-interrupt-approve': {
        decisions: [{
          reviewId: REVIEW_SPEC.id,
          selectedOptionId: 'approve',
        }],
      },
    });
    const approvedOutput = committedRows.join('\n');
    assertOrdered(approvedOutput.slice(interruptedOutput.length), [
      REVIEW_APPROVE_MESSAGE,
      REVIEW_APPROVED_REPLY,
    ]);

    assert.deepEqual(controller.submitChat(REVIEW_CANCEL_MESSAGE), {
      ok: true,
      requestId: 'chat-review-cancel',
    });
    await waitFor(() => (
      controller.getState().session.activeRun?.state === 'pending_interrupt'
    ));
    const cancellationRun = controller.getState().session.activeRun;
    assert.ok(cancellationRun?.state === 'pending_interrupt');
    assert.equal(cancellationRun.pendingInterrupt.interruptId, 'review-interrupt-cancel');
    assert.deepEqual(controller.cancelReview({
      requestId: 'chat-review-cancel',
      interruptId: cancellationRun.pendingInterrupt.interruptId,
    }), {
      ok: true,
    });
    await waitFor(() => controller.getState().session.activeRun === null);
    assert.equal(snapshotRequestCount, 6);
    assert.deepEqual(graphFixture.reviewResumes()[1], {
      'review-interrupt-cancel': {
        action: 'interrupt_run',
      },
    });
    assert.deepEqual(
      controller.continueActiveDelegation(REVIEW_CONTINUE_GUIDANCE),
      {
        ok: true,
        requestId: 'chat-review-continue',
      },
    );
    await waitFor(() => (
      controller.getState().session.activeRun?.state === 'pending_interrupt'
    ));
    const continuedRun = controller.getState().session.activeRun;
    assert.ok(continuedRun?.state === 'pending_interrupt');
    assert.equal(
      continuedRun.pendingInterrupt.interruptId,
      'review-interrupt-cancel',
    );
    const continuedApproval = controller.submitReviewResponse({
      requestId: 'chat-review-continue',
      interruptId: continuedRun.pendingInterrupt.interruptId,
      decisions: [],
      optionId: 'approve',
    });
    assert.equal(continuedApproval.ok, true);
    await waitFor(() => (
      snapshotRequestCount === 7
      && controller.getState().session.activeRun === null
      && hasCompletedRequestMessage(
        controller.getState().session,
        'chat-review-continue',
        REVIEW_APPROVED_REPLY,
      )
    ));
    assert.deepEqual(graphFixture.reviewResumes()[2], {
      'review-interrupt-cancel': {
        decisions: [{
          reviewId: REVIEW_SPEC.id,
          selectedOptionId: 'approve',
        }],
      },
    });
    const cancelledOutput = committedRows.join('\n');
    assertOrdered(cancelledOutput.slice(approvedOutput.length), [
      REVIEW_CANCEL_MESSAGE,
      'interrupted',
      REVIEW_CONTINUE_GUIDANCE,
      REVIEW_APPROVED_REPLY,
    ]);

    assert.deepEqual(controller.submitChat(ERROR_MESSAGE), {
      ok: true,
      requestId: 'chat-error',
    });
    await waitFor(() => (
      snapshotRequestCount === 8
      && controller.getState().session.activeRun === null
      && hasCompletedRequestMessage(
        controller.getState().session,
        'chat-error',
        GRAPH_ERROR,
        'system',
      )
    ));
    const errorEntries = requestMessageEntries(
      controller.getState().session,
      'chat-error',
    );
    assert.deepEqual(
      errorEntries.map((entry) => `${entry.role}:${entry.status}:${entry.text}`),
      [
        `user:completed:${ERROR_MESSAGE}`,
        `assistant:completed:${ERROR_PARTIAL}`,
        `system:completed:${GRAPH_ERROR}`,
      ],
    );
    const errorOutput = committedRows.join('\n');
    assertOrdered(errorOutput.slice(cancelledOutput.length), [
      ERROR_MESSAGE,
      ERROR_PARTIAL,
      GRAPH_ERROR,
    ]);

    assert.deepEqual(controller.submitChat(RECOVERY_MESSAGE), {
      ok: true,
      requestId: 'chat-recovery',
    });
    await waitFor(() => (
      snapshotRequestCount === 9
      && controller.getState().session.activeRun === null
      && hasCompletedRequestMessage(
        controller.getState().session,
        'chat-recovery',
        ASSISTANT_MESSAGE,
      )
    ));
    assert.deepEqual(
      controller.getState().session.timeline
        .filter((entry) => entry.requestId === 'chat-recovery')
        .map(timelineEntryShape),
      [
        'message:user:completed',
        'operation:runtime.read_fixture:completed',
        'message:subagent:completed',
        'message:assistant:completed',
      ],
    );
    const recoveryOutput = committedRows.join('\n');
    assertOrdered(recoveryOutput.slice(errorOutput.length), [
      RECOVERY_MESSAGE,
      'read_fixture',
      'Found transport evidence.',
      'The host transport is aligned.',
    ]);
    // The final response also schedules OpenTUI's asynchronous Markdown
    // highlighting. Let it settle before destroying the shared renderer/tree
    // sitter client so native test files cannot race its fallback callback.
    await Bun.sleep(200);
    assert.equal(chatRequestCount, 7);
    assert.equal(graphFixture.streamCount(), 10);
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

function timelineEntryShape(entry: AgentTimelineEntry) {
  return entry.type === 'operation'
    ? `operation:${entry.kind}:${entry.phase}`
    : `message:${entry.role}:${entry.status}`;
}

function hasCompletedRequestMessage(
  session: AgentSession,
  requestId: string,
  text: string,
  role: 'assistant' | 'system' = 'assistant',
) {
  return session.timeline.some((entry) => (
    entry.type === 'message'
    && entry.role === role
    && entry.requestId === requestId
    && entry.status === 'completed'
    && entry.text === text
  ));
}

function requestMessageEntries(
  session: AgentSession,
  requestId: string,
) {
  return session.timeline.filter(
    (entry): entry is Extract<AgentTimelineEntry, { type: 'message' }> => (
      entry.type === 'message' && entry.requestId === requestId
    ),
  );
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

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
