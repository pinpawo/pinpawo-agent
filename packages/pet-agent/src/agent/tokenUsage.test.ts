import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage } from '@langchain/core/messages';
import {
  streamOrchestratorGraph,
  type OrchestratorGraph,
} from './createAgentRuntime';
import {
  checkProviderInputWatermark,
  createTokenUsageSnapshot,
  isTokenUsageSnapshot,
  parseTokenUsageSnapshot,
  readLatestProviderInputTokens,
  readMessageTokenUsage,
  readMessagesTokenUsage,
} from './tokenUsage';

test('parseTokenUsageSnapshot validates canonical token usage snapshots', () => {
  const usage = parseTokenUsageSnapshot({
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    latestInputTokens: 12,
    contextWindow: 64000,
    updatedAt: '2026-06-24T10:00:00.000Z',
    source: 'provider',
    scope: 'run',
  });

  assert.deepEqual(usage, {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    latestInputTokens: 12,
    contextWindow: 64000,
    updatedAt: '2026-06-24T10:00:00.000Z',
    source: 'provider',
    scope: 'run',
  });
  assert.equal(isTokenUsageSnapshot(usage), true);

  assert.equal(parseTokenUsageSnapshot({
    inputTokens: 20,
    outputTokens: 10,
    totalTokens: 30,
    scope: 'session',
  })?.scope, 'session');
});

test('parseTokenUsageSnapshot rejects incomplete token usage snapshots', () => {
  assert.equal(parseTokenUsageSnapshot({
    inputTokens: 10,
    outputTokens: 5,
  }), null);
  assert.equal(isTokenUsageSnapshot({
    inputTokens: 10,
    outputTokens: 5,
  }), false);
});

test('readMessageTokenUsage reads AIMessage usage metadata', () => {
  const message = new AIMessage({
    content: 'ok',
    usage_metadata: {
      input_tokens: 12,
      output_tokens: 5,
      total_tokens: 17,
    },
  });

  assert.deepEqual(readMessageTokenUsage(message), {
    inputTokens: 12,
    outputTokens: 5,
    totalTokens: 17,
  });
});

test('readMessageTokenUsage reads camel-case usage metadata', () => {
  const message = {
    usageMetadata: {
      inputTokens: 12,
      outputTokens: 5,
      totalTokens: 17,
    },
  };

  assert.deepEqual(readMessageTokenUsage(message), {
    inputTokens: 12,
    outputTokens: 5,
    totalTokens: 17,
  });
});

test('readMessagesTokenUsage aggregates provider usage from messages', () => {
  const messages = [
    new AIMessage({
      content: 'one',
      usage_metadata: {
        input_tokens: 10,
        output_tokens: 2,
        total_tokens: 12,
      },
    }),
    new AIMessage('no usage'),
    new AIMessage({
      content: 'two',
      usage_metadata: {
        input_tokens: 3,
        output_tokens: 4,
        total_tokens: 7,
      },
    }),
  ];

  const usage = readMessagesTokenUsage(messages);
  assert.deepEqual(usage, {
    inputTokens: 13,
    outputTokens: 6,
    totalTokens: 19,
  });
  const snapshot = createTokenUsageSnapshot(usage, 64000, 13);
  assert.deepEqual(snapshot, {
    inputTokens: 13,
    outputTokens: 6,
    totalTokens: 19,
    latestInputTokens: 13,
    contextWindow: 64000,
    updatedAt: snapshot?.updatedAt,
    source: 'provider',
    scope: 'run',
  });
  assert.equal(typeof snapshot?.updatedAt, 'string');
});

test('readLatestProviderInputTokens reads the latest provider prompt footprint', () => {
  const messages = [
    new AIMessage({
      content: 'one',
      usage_metadata: {
        input_tokens: 10,
        output_tokens: 2,
        total_tokens: 12,
      },
    }),
    new AIMessage({
      content: 'two',
      usage_metadata: {
        input_tokens: 30,
        output_tokens: 4,
        total_tokens: 34,
      },
    }),
  ];

  assert.equal(readLatestProviderInputTokens(messages), 30);
  assert.equal(readLatestProviderInputTokens([new AIMessage('no usage')]), null);
});

test('readLatestProviderInputTokens accepts provider usage stored in response metadata', () => {
  const messages = [
    new AIMessage({
      content: 'older reply',
      response_metadata: {
        tokenUsage: {
          promptTokens: 25,
          completionTokens: 5,
          totalTokens: 30,
        },
      },
    }),
    new AIMessage({
      content: 'latest reply',
      response_metadata: {
        usage: {
          prompt_tokens: 900,
          completion_tokens: 30,
          total_tokens: 930,
        },
      },
    }),
  ];

  assert.equal(readLatestProviderInputTokens(messages), 900);
  assert.deepEqual(readMessageTokenUsage(messages[0]), {
    inputTokens: 25,
    outputTokens: 5,
    totalTokens: 30,
  });
});

test('checkProviderInputWatermark reports the crossed watermark with its evidence', () => {
  assert.deepEqual(checkProviderInputWatermark(900, 1000), {
    latestInputTokens: 900,
    watermarkTokens: 750,
  });
  assert.deepEqual(checkProviderInputWatermark(750, 1000), {
    latestInputTokens: 750,
    watermarkTokens: 750,
  });
  // The watermark is floored to an integer token count.
  assert.deepEqual(checkProviderInputWatermark(750, 1001), {
    latestInputTokens: 750,
    watermarkTokens: 750,
  });
  assert.equal(checkProviderInputWatermark(749, 1000), null);
  assert.equal(checkProviderInputWatermark(null, 1000), null);
  assert.equal(checkProviderInputWatermark(900, undefined), null);
  assert.equal(checkProviderInputWatermark(900, 0), null);
});

test('checkProviderInputWatermark reserves generation capacity before applying the ratio', () => {
  assert.deepEqual(checkProviderInputWatermark(600, 1000, 200), {
    latestInputTokens: 600,
    watermarkTokens: 600,
  });
  assert.equal(checkProviderInputWatermark(599, 1000, 200), null);
});

test('streamOrchestratorGraph streams graph chunks without injecting callbacks', async () => {
  let receivedOptions: unknown = null;
  const graph = {
    stream: async (_input: unknown, options?: unknown) => {
      receivedOptions = options;
      return (async function* () {
        yield ['values', { messages: [] }];
      })();
    },
  } as unknown as OrchestratorGraph;

  const stream = streamOrchestratorGraph(graph, {}, { configurable: { thread_id: 'thread-1' } });
  const chunks: unknown[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  assert.deepEqual(receivedOptions, { configurable: { thread_id: 'thread-1' } });
  assert.deepEqual(chunks, [
    ['values', { messages: [] }],
  ]);
});
