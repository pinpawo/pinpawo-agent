import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage } from '@langchain/core/messages';
import type { LLMResult } from '@langchain/core/outputs';
import {
  streamOrchestratorGraph,
  type OrchestratorGraph,
} from './createAgentRuntime';
import {
  createTokenUsageSnapshot,
  isTokenUsageSnapshot,
  parseTokenUsageSnapshot,
  readLlmResultTokenUsage,
  readMessageTokenUsage,
  readMessagesTokenUsage,
} from './tokenUsage';

test('readLlmResultTokenUsage reads OpenAI llmOutput token usage', () => {
  const usage = readLlmResultTokenUsage({
    generations: [],
    llmOutput: {
      tokenUsage: {
        promptTokens: 12,
        completionTokens: 5,
        totalTokens: 17,
      },
    },
  } as LLMResult);

  assert.deepEqual(usage, {
    inputTokens: 12,
    outputTokens: 5,
    totalTokens: 17,
  });
});

test('readLlmResultTokenUsage includes Anthropic top-level cache input tokens', () => {
  const usage = readLlmResultTokenUsage({
    generations: [
      [
        {
          text: 'ok',
          generationInfo: {
            usage: {
              input_tokens: 20,
              cache_creation_input_tokens: 3,
              cache_read_input_tokens: 7,
              output_tokens: 11,
            },
          },
        },
      ],
    ],
  } as LLMResult);

  assert.deepEqual(usage, {
    inputTokens: 30,
    outputTokens: 11,
    totalTokens: 41,
  });
});

test('parseTokenUsageSnapshot validates canonical token usage snapshots', () => {
  const usage = parseTokenUsageSnapshot({
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    contextWindow: 64000,
    updatedAt: '2026-06-24T10:00:00.000Z',
    source: 'provider',
    scope: 'run',
  });

  assert.deepEqual(usage, {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    contextWindow: 64000,
    updatedAt: '2026-06-24T10:00:00.000Z',
    source: 'provider',
    scope: 'run',
  });
  assert.equal(isTokenUsageSnapshot(usage), true);
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
      response_metadata: {
        tokenUsage: {
          promptTokens: 3,
          completionTokens: 4,
          totalTokens: 7,
        },
      },
    }),
  ];

  const usage = readMessagesTokenUsage(messages);
  assert.deepEqual(usage, {
    inputTokens: 13,
    outputTokens: 6,
    totalTokens: 19,
  });
  const snapshot = createTokenUsageSnapshot(usage, 64000);
  assert.deepEqual(snapshot, {
    inputTokens: 13,
    outputTokens: 6,
    totalTokens: 19,
    contextWindow: 64000,
    updatedAt: snapshot?.updatedAt,
    source: 'provider',
    scope: 'run',
  });
  assert.equal(typeof snapshot?.updatedAt, 'string');
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
