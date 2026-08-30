import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createAgent, createMiddleware } from 'langchain';
import { DelegationAnnounceMessage } from './delegation';
import {
  createModelRequestMessagesMiddleware,
  prepareModelRequestMessages,
} from './modelRequestMessages';

class RecordingModel extends BaseChatModel {
  readonly invocations: BaseMessage[][] = [];

  _llmType() {
    return 'model-request-recorder';
  }

  bindTools() {
    return this;
  }

  async _generate(messages: BaseMessage[]) {
    this.invocations.push(messages);
    const message = new AIMessage('done');
    return { generations: [{ message, text: message.text }] };
  }
}

test('prepareModelRequestMessages projects typed canonical messages without mutating state', () => {
  const request = new HumanMessage('检查代码并继续。');
  const accepted = new DelegationAnnounceMessage({
    id: 'accepted-1',
    sourceLane: 'capability:explore',
    delegationId: 'delegation-accepted',
    runId: 'run-old',
    announceMessageId: 'announce-old',
    task: '检查历史实现',
    completionReason: 'natural',
    result: '历史实现已检查。',
    createdAt: '2026-01-01T00:00:00.000Z',
  });

  const messages = prepareModelRequestMessages([request, accepted]);

  assert.equal(messages.length, 2);
  assert.equal(messages[0], request);
  assert.notEqual(messages[1], accepted);
  assert.match(messages[1]?.text ?? '', /<delegation_announce/);
  assert.match(messages[1]?.text ?? '', /历史实现已检查/);
  assert.equal(accepted.text, '历史实现已检查。');
});

test('prepareModelRequestMessages repairs the complete model-request tool protocol', () => {
  const toolCall = new AIMessage({
    content: '',
    tool_calls: [{ id: 'call-1', name: 'inspect', args: {} }],
  });
  const toolResult = new ToolMessage({
    content: 'inspection complete',
    tool_call_id: 'call-1',
  });

  const messages = prepareModelRequestMessages([toolCall, toolResult]);

  assert.deepEqual(messages, [toolCall, toolResult]);
});

test('final request middleware prepares messages added by an earlier middleware without mutating agent state', async () => {
  const accepted = new DelegationAnnounceMessage({
    id: 'accepted-1',
    sourceLane: 'capability:explore',
    delegationId: 'delegation-accepted',
    runId: 'run-old',
    announceMessageId: 'announce-old',
    task: '检查历史实现',
    completionReason: 'natural',
    result: '历史实现已检查。',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  const invocationInput = new HumanMessage({
    id: 'invocation-only',
    content: 'CURRENT_INVOCATION_INPUT',
  });
  const appendInvocationInput = createMiddleware({
    name: 'AppendInvocationInput',
    wrapModelCall: (request, handler) => handler({
      ...request,
      messages: [...request.messages, invocationInput],
    }),
  });
  const model = new RecordingModel({});
  const agent = createAgent({
    model,
    tools: [],
    middleware: [
      appendInvocationInput,
      createModelRequestMessagesMiddleware(),
    ],
  });

  const result = await agent.invoke({
    messages: [new HumanMessage('继续。'), accepted],
  });

  const invoked = model.invocations[0] ?? [];
  const projected = invoked.find((message) => message.id === accepted.id);
  assert.ok(projected);
  assert.notEqual(projected, accepted);
  assert.match(projected.text, /<delegation_announce/);
  assert.equal(invoked.at(-1), invocationInput);
  assert.equal(result.messages.includes(accepted), true);
  assert.equal(result.messages.includes(invocationInput), false);
});
