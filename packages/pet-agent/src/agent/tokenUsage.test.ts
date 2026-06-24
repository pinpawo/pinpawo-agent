import assert from 'node:assert/strict';
import test from 'node:test';
import type { LLMResult } from '@langchain/core/outputs';
import {
  streamOrchestratorGraphWithTokenUsage,
  type OrchestratorGraph,
} from './createAgentRuntime';
import {
  isTokenUsageSnapshot,
  parseTokenUsageSnapshot,
  readLlmResultTokenUsage,
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

test('streamOrchestratorGraphWithTokenUsage tracks provider usage through graph callbacks', async () => {
  type TestCallback = {
    handleLLMEnd?: (output: LLMResult, runId: string) => unknown;
  };

  let callbackWasAttached = false;
  const graph = {
    stream: async (_input: unknown, options?: unknown) => {
      const callbacks = (options as { callbacks?: TestCallback[] } | undefined)?.callbacks ?? [];
      callbackWasAttached = callbacks.length > 0;
      await callbacks[0]?.handleLLMEnd?.({
        generations: [],
        llmOutput: {
          tokenUsage: {
            promptTokens: 123,
            completionTokens: 45,
            totalTokens: 168,
          },
        },
      } as LLMResult, 'llm-run-1');
      return (async function* () {
        yield ['values', { messages: [] }];
      })();
    },
  } as unknown as OrchestratorGraph;

  const stream = streamOrchestratorGraphWithTokenUsage(graph, {}, {});
  const chunks: unknown[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  assert.equal(callbackWasAttached, true);
  assert.deepEqual(chunks, [
    ['values', { messages: [] }],
  ]);
  const usage = stream.readTokenUsage(64000);
  assert.deepEqual(usage, {
    inputTokens: 123,
    outputTokens: 45,
    totalTokens: 168,
    contextWindow: 64000,
    updatedAt: usage?.updatedAt,
    source: 'provider',
    scope: 'run',
  });
  assert.equal(typeof usage?.updatedAt, 'string');
});
