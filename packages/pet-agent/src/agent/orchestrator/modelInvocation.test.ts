import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createAgent, createMiddleware } from 'langchain';
import { DelegationAnnounceMessage } from './delegation';
import {
  invokeOrchestratorModel,
  orchestratorModelInvocationMiddleware,
} from './modelInvocation';

class RecordingModel extends BaseChatModel {
  readonly invocations: BaseMessage[][] = [];

  _llmType() {
    return 'model-invocation-recorder';
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

function acceptedAnnounce() {
  return new DelegationAnnounceMessage({
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
}

test('direct invocation keeps system ownership separate and projects Agent messages', async () => {
  const accepted = acceptedAnnounce();
  const systemMessage = new SystemMessage('SYSTEM');
  const model = new RecordingModel({});

  await invokeOrchestratorModel(model, {
    systemMessage,
    messages: [new HumanMessage('继续。'), accepted],
  });

  const invoked = model.invocations[0] ?? [];
  assert.equal(invoked[0], systemMessage);
  const projected = invoked.find((message) => message.id === accepted.id);
  assert.ok(projected);
  assert.notEqual(projected, accepted);
  assert.match(projected.text, /<delegation_announce/);
  assert.equal(accepted.text, '历史实现已检查。');
});

test('direct invocation repairs invalid tool protocol before the model call', async () => {
  const danglingCall = new AIMessage({
    id: 'dangling-call',
    content: '',
    tool_calls: [{ id: 'call-1', name: 'inspect', args: {} }],
  });
  const orphanResult = new ToolMessage({
    id: 'orphan-result',
    content: 'orphan',
    tool_call_id: 'other-call',
  });
  const model = new RecordingModel({});

  await invokeOrchestratorModel(model, {
    systemMessage: new SystemMessage('SYSTEM'),
    messages: [
      new HumanMessage('继续。'),
      danglingCall,
      new AIMessage('intervening response'),
      orphanResult,
    ],
  });

  const invokedIds = (model.invocations[0] ?? []).map((message) => message.id);
  assert.equal(invokedIds.includes('dangling-call'), false);
  assert.equal(invokedIds.includes('orphan-result'), false);
});

test('Agent invocation applies after earlier middleware without mutating state', async () => {
  const accepted = acceptedAnnounce();
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
      orchestratorModelInvocationMiddleware,
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
