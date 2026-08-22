import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { startStudioStdioTransport } from './startStudioTransport';
import type { Studio, StudioEventHandler } from '../studioContract';

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

function fakeStudio(): Studio {
  const handlers = new Set<StudioEventHandler>();
  return {
    entryPetId: 'pet-a',
    dispatch: async () => ({
      petId: 'pet-1',
      threadId: 'thread-1',
      invocationId: 'invocation-1',
      completion: Promise.resolve({
        petId: 'pet-1',
        threadId: 'thread-1',
        invocationId: 'invocation-1',
        status: 'completed',
      }),
    }),
    onInvocation: () => () => {},
    notify: (event) => { for (const handler of handlers) void handler(event); },
    subscribe: (handler) => { handlers.add(handler); return () => handlers.delete(handler); },
    listPets: () => [],
    shutdown: async () => {},
  };
}

test('the independent Studio stdio transport dispatches studio requests', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const readOutput = collectText(output);

  const transport = startStudioStdioTransport({
    studio: fakeStudio(),
  }, {
    input,
    output,
    diagnostics: new PassThrough(),
  });

  input.write(`${JSON.stringify({
    type: 'studio.dispatch',
    deliveryId: 'delivery-1',
    petId: 'pet-1',
    input: { kind: 'request', request: 'go' },
  })}\n`);

  await assertEventually(() => {
    const messages = parseJsonLines(readOutput());
    const response = messages.find(
      (m) => (m as { type: string }).type === 'studio.accepted',
    );
    assert.ok(response, 'expected a studio.accepted message');
  });

  input.end();
  await transport.closed;

  const messages = parseJsonLines(readOutput()) as Array<{ type: string; deliveryId?: string }>;
  const response = messages.find((m) => m.type === 'studio.accepted');
  assert.ok(response);
  assert.equal(response!.deliveryId, 'delivery-1');

  const error = messages.find((m) => m.type === 'studio.error');
  assert.equal(error, undefined);
});
