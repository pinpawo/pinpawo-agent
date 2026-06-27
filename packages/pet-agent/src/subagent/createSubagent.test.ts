import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { tool } from '@langchain/core/tools';
import { FakeToolCallingModel } from 'langchain';
import { z } from 'zod';
import { createSubagent } from './createSubagent';
import { readLoopGuardStopReason } from './loopGuards';

/**
 * Minimal model that never converges: it keeps emitting a fresh tool call every
 * turn. Paired with a contextPolicy that collapses the transcript back to a fixed
 * list, the messages submitted to the model repeat across turns — the exact
 * condition RepeatedInputGuard is meant to catch.
 */
class NeverConvergingModel extends BaseChatModel {
  callCount = 0;
  _llmType() {
    return 'never-converging';
  }
  async _generate() {
    this.callCount += 1;
    const message = new AIMessage({
      content: '',
      tool_calls: [{ id: `call-${this.callCount}`, name: 'noop', args: {} }],
    });
    return { generations: [{ message, text: '' }] };
  }
  bindTools() {
    return this;
  }
}

test('createSubagent emits non-tool model text as runtime deltas', async () => {
  const events: unknown[] = [];

  const result = await createSubagent({
    model: new FakeListChatModel({
      responses: ['subagent result'],
      sleep: 0,
    }),
    tools: [],
    instructions: [],
    messages: [new HumanMessage('do the task')],
    maxIterations: 4,
    onToolEvent: (event) => {
      events.push(event);
    },
  });

  assert.equal(result.completionReason, 'natural');
  const deltas = events.filter((event): event is {
    event: 'on_runtime_event';
    name: 'subagent_message_delta';
    data: { text: string };
  } => Boolean(
    event
      && typeof event === 'object'
      && (event as { event?: unknown }).event === 'on_runtime_event'
      && (event as { name?: unknown }).name === 'subagent_message_delta',
  ));
  assert.equal(deltas.map((event) => event.data.text).join(''), 'subagent result');
});

test('createSubagent returns limit_reached when context fuse trips before model call', async () => {
  const result = await createSubagent({
    model: new FakeListChatModel({
      responses: ['this response should not be used'],
      sleep: 0,
    }),
    tools: [],
    instructions: [],
    messages: [new HumanMessage(`do the task\n${'x'.repeat(2000)}`)],
    maxIterations: 4,
    contextWindowTokens: 256,
  });

  assert.equal(result.completionReason, 'limit_reached');
  assert.equal(result.messages.at(-1)?._getType(), 'ai');
  assert.match(String(result.messages.at(-1)?.content ?? ''), /上下文已接近模型窗口上限/);
});

test('createSubagent contextPolicy rewrites persisted subagent transcript', async () => {
  const readFile = tool(async () => `file output\n${'x'.repeat(2600)}`, {
    name: 'view_file_chunk',
    description: 'read file chunk',
    schema: z.object({ path: z.string() }),
  });
  const result = await createSubagent({
    model: new FakeToolCallingModel({
      toolCalls: [
        [{
          id: 'call-read',
          name: 'view_file_chunk',
          args: { path: 'src/a.ts' },
        }],
        [],
      ],
    }),
    tools: [readFile],
    instructions: [],
    operations: {
      view_file_chunk: {
        summarizeInput: (input) => ({ target: (input as { path?: string }).path }),
      },
    },
    contextPolicy: {
      evictToolResults: {
        keepRecent: 0,
        budgetTokens: 100,
        minSizeChars: 2000,
      },
    },
    messages: [new HumanMessage('read the file')],
    maxIterations: 8,
  });

  assert.equal(result.completionReason, 'natural');
  const toolMessages = result.messages.filter((message) => message._getType() === 'tool');
  assert.equal(toolMessages.length, 1);
  assert.equal(toolMessages[0]?.content, '[evicted: view_file_chunk src/a.ts -> 已读；需要时重新调用]');
});

test('createSubagent returns limit_reached when the repeated-input guard trips', async () => {
  const noop = tool(async () => 'same', {
    name: 'noop',
    description: 'no-op',
    schema: z.object({}),
  });
  const model = new NeverConvergingModel({});
  // Collapse every turn back to the same fixed list so the model input repeats —
  // the spinning-on-identical-input condition RepeatedInputGuard guards against.
  const fixedTranscript: BaseMessage[] = [new HumanMessage('do the task')];

  const result = await createSubagent({
    model: model as unknown as BaseChatModel,
    tools: [noop],
    instructions: [],
    messages: [new HumanMessage('do the task')],
    maxIterations: 30,
    contextPolicy: { rewrite: () => fixedTranscript },
  });

  // The guard stopped the loop well before the maxIterations breaker.
  assert.equal(result.completionReason, 'limit_reached');
  assert.ok(model.callCount < 30, `guard should stop early, got ${model.callCount} model calls`);

  // The stop notice is present and carries the typed guard-stop reason.
  const last = result.messages.at(-1);
  assert.ok(last);
  assert.equal(last?._getType(), 'ai');
  assert.equal(readLoopGuardStopReason(last as BaseMessage), 'repeated_input');
  assert.match(String(last?.content ?? ''), /原地打转/);

  // The subagent transcript (the prior conversation) is preserved alongside the
  // notice — the stop appends, it does not replace context.
  assert.ok(
    result.messages.length > 1,
    'expected the conversation context to be kept alongside the stop notice',
  );
  assert.equal(result.messages[0]?._getType(), 'human');
});
