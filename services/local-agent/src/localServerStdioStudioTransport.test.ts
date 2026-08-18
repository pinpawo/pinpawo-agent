import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import type { LocalServerDeps } from './localServerTypes';
import { LocalServerStudioHandler } from './localServerStudioHandler';
import type { LocalServerPeer } from './localServerPeer';
import { startLocalStdioServer } from './localServerStdioTransport';
import { createTestModelServerDeps } from './testing/modelProfiles';
import type { Studio, StudioEventHandler } from '@pinpawo/studio';

function collectText(stream: PassThrough) {
  let value = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    value += chunk;
  });
  return () => value;
}

function parseJsonLines(value: string) {
  return value.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as unknown);
}

async function assertEventually(assertion: () => void) {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < 1000) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
    }
  }
  throw lastError;
}

function createStudioDeps(): LocalServerDeps {
  return {
    serverMode: 'studio',
    actorId: 'pet-a',
    workdir: '/tmp/pinpawo-studio-test',
    ...createTestModelServerDeps(),
  };
}

function fakeStudio(): Studio {
  const handlers = new Set<StudioEventHandler>();
  return {
    entryPetId: 'pet-a',
    dispatch: async () => ({ threadId: 'thread-1' }),
    notify: (event) => { for (const handler of handlers) void handler(event); },
    subscribe: (handler) => { handlers.add(handler); return () => handlers.delete(handler); },
    listPets: () => [],
    shutdown: async () => {},
  };
}

test('startLocalStdioServer dispatches studio requests via injected studioHandler', async () => {
  // P1-1 regression: startLocalStdioServer must pass studioHandler to
  // createLocalServerHandlers. Without it, onStudioRequest returns
  // "Studio handler is not available" even in studio mode.
  const input = new PassThrough();
  const output = new PassThrough();
  const readOutput = collectText(output);

  const studio = fakeStudio();
  const studioHandler = new LocalServerStudioHandler<LocalServerPeer>({
    studio,
    outbound: {
      sendMessage: (peer, message) => peer.send(message),
      sendEvent: () => true,
    },
  });

  const transport = startLocalStdioServer(createStudioDeps(), {
    input,
    output,
    diagnostics: new PassThrough(),
    studioHandler,
  });

  input.write(`${JSON.stringify({
    type: 'studio_request',
    requestId: 'studio-1',
    userRequest: 'go',
  })}\n`);

  await assertEventually(() => {
    const messages = parseJsonLines(readOutput());
    const response = messages.find(
      (m) => (m as { type: string }).type === 'studio_response',
    );
    assert.ok(response, 'expected a studio_response message');
  });

  input.end();
  await transport.closed;

  const messages = parseJsonLines(readOutput()) as Array<{ type: string; requestId?: string }>;
  const response = messages.find((m) => m.type === 'studio_response');
  assert.ok(response);
  assert.equal(response!.requestId, 'studio-1');

  // Ensure we did NOT get a studio_error about handler not being available.
  const error = messages.find((m) => m.type === 'studio_error');
  assert.equal(error, undefined);
});
