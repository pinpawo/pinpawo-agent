import assert from 'node:assert/strict';
import test from 'node:test';
import { HumanMessage } from '@langchain/core/messages';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { createSubagent } from './createSubagent';

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
