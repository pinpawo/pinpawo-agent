import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  EmbeddedHostConnection,
} from '../src/client/embeddedHostConnection';
import { TuiSessionController } from '../src/session/sessionController';
import { ASSISTANT_MESSAGE } from './support/hostGraphFixture';

const HOST_SCRIPT = fileURLToPath(new URL(
  './support/embeddedHostProcess.ts',
  import.meta.url,
));
const USER_MESSAGE = 'Inspect the embedded host.';

/**
 * The embedded transport in the shape the terminal UI actually uses it: the
 * session controller talks to a real Host child process over a piped JSONL
 * stream, with no WebSocket, port, or auth token involved.
 */
test('the embedded stdio transport drives the session controller against a real Host child', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'pinpawo-tui-embedded-host-'));
  let controller: TuiSessionController | null = null;
  let connection: EmbeddedHostConnection | null = null;
  const diagnostics: string[] = [];

  try {
    let requestIndex = 0;
    controller = new TuiSessionController({
      connectionFactory: (handlers) => {
        connection = new EmbeddedHostConnection(handlers, {
          command: process.execPath,
          args: ['run', HOST_SCRIPT, workdir],
          cwd: workdir,
          onDiagnostics: (line) => diagnostics.push(line),
        });
        return connection;
      },
      requestIdFactory: () => `embedded-request-${requestIndex += 1}`,
      // Embedded stdio disconnects the Host on teardown, so the synchronization
      // timeout stays disabled exactly as `main.ts` configures it.
      snapshotTimeoutMs: null,
    });

    controller.start();
    await waitFor(() => controller?.getState().connection === 'ready');
    assert.notEqual(controller.getState().session.sessionId, 'pending');
    assert.equal(connection!.isConnected(), true);

    assert.equal(controller.submitChat(USER_MESSAGE).ok, true);
    await waitFor(() => (
      controller?.getState().session.activeRun === null
      && completedMessages(controller).includes(`assistant:${ASSISTANT_MESSAGE}`)
    ));
    // The scripted graph also emits a subagent step; the canonical conversation
    // still travels both ways over the pipe.
    assert.deepEqual(completedMessages(controller), [
      `user:${USER_MESSAGE}`,
      `assistant:${ASSISTANT_MESSAGE}`,
    ]);

    controller.stop();
    // Stopping the session ends the Host child instead of leaving it running.
    await waitFor(() => connection?.isConnected() === false);
  } finally {
    controller?.stop();
    rmSync(workdir, { recursive: true, force: true });
  }
});

function completedMessages(controller: TuiSessionController) {
  return controller.getState().session.timeline.flatMap((entry) => (
    entry.type === 'message'
    && entry.status === 'completed'
    && (entry.role === 'user' || entry.role === 'assistant')
      ? [`${entry.role}:${entry.text}`]
      : []
  ));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`condition was not met within ${timeoutMs}ms`);
    }
    await Bun.sleep(10);
  }
}
