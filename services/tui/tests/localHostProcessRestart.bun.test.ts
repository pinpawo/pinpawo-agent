import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  LocalHostConnection,
} from '../src/client/localHostConnection';
import {
  TuiSessionController,
} from '../src/session/sessionController';
import {
  PERSISTENT_HOST_CONTINUATION,
  PERSISTENT_HOST_CONTINUATION_REPLY,
  PERSISTENT_HOST_INPUT,
  PERSISTENT_HOST_REPLY,
} from './support/persistentHostGraphService';
import {
  spawnHostProcess,
  stopHostProcess,
  type HostProcess,
} from './support/localHostProcessHarness';

const AUTH_TOKEN = 'tui-v2-process-restart-token';

test('v2 reconnects after the production local host process restarts', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'pinpawo-tui-v2-process-'));
  let firstHost: HostProcess | null = null;
  let secondHost: HostProcess | null = null;
  let controller: TuiSessionController | null = null;

  try {
    firstHost = await spawnHostProcess({
      port: 0,
      workdir,
      authToken: AUTH_TOKEN,
    });
    const observedConnections: string[] = [];
    let requestIndex = 0;
    controller = new TuiSessionController({
      connectionFactory: (handlers) => new LocalHostConnection(handlers, {
        port: firstHost!.port,
        tokenProvider: () => AUTH_TOKEN,
      }),
      requestIdFactory: () => `process-request-${requestIndex += 1}`,
      reconnectDelaysMs: [25, 50, 100, 200, 400, 800],
      snapshotTimeoutMs: 1_000,
    });
    controller.subscribe((state) => {
      observedConnections.push(state.connection);
    });
    controller.start();
    await waitFor(() => controller?.getState().connection === 'ready');

    const originalSessionId = controller.getState().session.sessionId;
    assert.notEqual(originalSessionId, 'pending');
    assert.deepEqual(controller.getState().session.timeline, []);

    assert.equal(controller.submitChat(PERSISTENT_HOST_INPUT).ok, true);
    await waitFor(() => (
      controller?.getState().session.activeRun === null
      && completedAssistantTexts(controller).includes(PERSISTENT_HOST_REPLY)
    ));
    assert.deepEqual(
      completedMessageTexts(controller),
      [
        `user:${PERSISTENT_HOST_INPUT}`,
        `assistant:${PERSISTENT_HOST_REPLY}`,
      ],
    );

    await stopHostProcess(firstHost);
    await waitFor(() => (
      controller?.getState().connection === 'reconnecting'
      || controller?.getState().connection === 'disconnected'
    ));

    secondHost = await spawnHostProcess({
      port: firstHost.port,
      workdir,
      authToken: AUTH_TOKEN,
    });
    assert.equal(secondHost.port, firstHost.port);
    await waitFor(() => (
      controller?.getState().connection === 'ready'
      && controller.getState().session.sessionId === originalSessionId
    ), 4_000);

    assert.ok(observedConnections.includes('reconnecting'));
    assert.equal(controller.getState().session.sessionId, originalSessionId);
    assert.deepEqual(
      completedMessageTexts(controller),
      [
        `user:${PERSISTENT_HOST_INPUT}`,
        `assistant:${PERSISTENT_HOST_REPLY}`,
      ],
    );
    assert.equal(controller.getState().session.sessionTokenUsage?.totalTokens, 7);

    assert.equal(controller.submitChat(PERSISTENT_HOST_CONTINUATION).ok, true);
    await waitFor(() => (
      controller?.getState().session.activeRun === null
      && completedAssistantTexts(controller)
        .includes(PERSISTENT_HOST_CONTINUATION_REPLY)
    ));
    assert.deepEqual(
      completedMessageTexts(controller),
      [
        `user:${PERSISTENT_HOST_INPUT}`,
        `assistant:${PERSISTENT_HOST_REPLY}`,
        `user:${PERSISTENT_HOST_CONTINUATION}`,
        `assistant:${PERSISTENT_HOST_CONTINUATION_REPLY}`,
      ],
    );
  } finally {
    controller?.stop();
    if (secondHost) {
      await stopHostProcess(secondHost);
    }
    if (firstHost) {
      await stopHostProcess(firstHost);
    }
    rmSync(workdir, { recursive: true, force: true });
  }
});

function completedAssistantTexts(controller: TuiSessionController) {
  return controller.getState().session.timeline.flatMap((entry) => (
    entry.type === 'message'
    && entry.role === 'assistant'
    && entry.status === 'completed'
      ? [entry.text]
      : []
  ));
}

function completedMessageTexts(controller: TuiSessionController) {
  return controller.getState().session.timeline.flatMap((entry) => (
    entry.type === 'message' && entry.status === 'completed'
      ? [`${entry.role}:${entry.text}`]
      : []
  ));
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
    await Bun.sleep(10);
  }
}
