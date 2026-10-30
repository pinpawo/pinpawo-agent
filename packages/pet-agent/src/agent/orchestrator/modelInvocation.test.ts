import { createDeliveryResult, withDeliveryCalls } from '../../testing/capabilityDelivery';
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

import {
  assignToolCallIds,
  invokeOrchestratorModel,
  toolProtocolMiddleware,
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
  return createDeliveryResult({
    id: 'accepted-1',
    sourceLane: 'capability:explore',
    delegationId: 'delegation-accepted',
    runId: 'run-old',
    deliveryId: 'announce-old',
    task: '检查历史实现',
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
    messages: withDeliveryCalls([new HumanMessage('继续。'), accepted]),
  });

  const invoked = model.invocations[0] ?? [];
  assert.equal(invoked[0], systemMessage);
  const projected = invoked.find((message) => message.id === accepted.id);
  assert.ok(projected);
  assert.equal(projected, accepted);
  assert.ok(ToolMessage.isInstance(projected));
  assert.equal(JSON.parse(projected.text).delivery.text, '历史实现已检查。');

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
  const call = new AIMessage({ id: 'call', content: '',
    tool_calls: [{ name: 'delegate_capability', args: { briefing: 'Execute the current objective.' }, id: 'execution' }] });
  const delivery = new ToolMessage({ id: 'delivery', name: 'delegate_capability',
    tool_call_id: 'execution', content: 'Execution evidence' });
  const orphan = new ToolMessage({ id: 'orphan', tool_call_id: 'missing', content: 'orphan' });
  const invocationInput = new HumanMessage({
    id: 'invocation-only',
    content: 'CURRENT_INVOCATION_INPUT',
  });
  const appendInvocationInput = createMiddleware({
    name: 'AppendInvocationInput',
    wrapModelCall: (request, handler) => handler({
      ...request,
      messages: [...request.messages, invocationInput, orphan],
    }),
  });
  const model = new RecordingModel({});
  const agent = createAgent({
    model,
    tools: [],
    middleware: [
      appendInvocationInput,
      toolProtocolMiddleware,
    ],
  });

  const result = await agent.invoke({
    messages: [new HumanMessage('继续。'), call, delivery],
  });

  const invoked = model.invocations[0] ?? [];
  assert.equal(invoked.find((message) => message.id === call.id), call);
  assert.equal(invoked.find((message) => message.id === delivery.id), delivery);
  assert.equal(invoked.includes(orphan), false);
  assert.equal(invoked.at(-1), invocationInput);
  assert.equal(result.messages.includes(call), true);
  assert.equal(result.messages.includes(delivery), true);
  assert.equal(result.messages.includes(invocationInput), false);
});

test('tool call IDs are settled once, keeping provider IDs that are already unique', () => {
  const unique = new AIMessage({ content: '', tool_calls: [{ id: 'call-A', name: 'read', args: {} }] });
  assert.equal(assignToolCallIds(unique, []), unique);

  const history = [new AIMessage({ content: '', tool_calls: [{ id: 'functions.read:0', name: 'read', args: {} }] })];
  const repeated = new AIMessage({ content: '', tool_calls: [
    { id: 'functions.read:0', name: 'read', args: { path: 'a' } },
    { id: '', name: 'read', args: { path: 'b' } },
    { id: 'call-B', name: 'read', args: { path: 'c' } },
    { id: 'call-B', name: 'read', args: { path: 'd' } },
  ] });
  const ids = assignToolCallIds(repeated, history).tool_calls!.map((call) => call.id!);
  assert.equal(new Set([...ids, 'functions.read:0']).size, 5);
  assert.equal(ids[2], 'call-B');
});

test('a streamed response keeps one copy of each call after its ID is settled', () => {
  const call = { id: 'functions.plan_request:0', name: 'plan_request', args: { goal: 'x' } };
  const streamed = new AIMessage({
    content: [{ type: 'reasoning', reasoning: 'think' }, { type: 'tool_call', ...call }],
    tool_calls: [call],
    additional_kwargs: { tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: '{"goal":"x"}' } }] },
    response_metadata: { output_version: 'v1' },
  });
  const settled = assignToolCallIds(streamed, [new AIMessage({ content: '', tool_calls: [call] })]);
  const rebuilt = new AIMessage({ ...settled });
  assert.equal(rebuilt.tool_calls?.length, 1);
  assert.notEqual(rebuilt.tool_calls![0].id, call.id);
  assert.deepEqual((rebuilt.content as Array<{ type: string; id?: string }>).map((block) => [block.type, block.id]),
    [['reasoning', undefined], ['tool_call', rebuilt.tool_calls![0].id]]);
  assert.equal((rebuilt.additional_kwargs.tool_calls as Array<{ id: string }>)[0].id, rebuilt.tool_calls![0].id);
});


test('native tool_use IDs stay paired after a provider reuses a history ID', () => {
  const call = { id: 'toolu_reused', name: 'lookup', args: { query: 'hello' } };
  const response = new AIMessage({
    content: [{ type: 'text', text: 'Looking up' }, { type: 'tool_use', id: call.id, name: call.name, input: call.args }],
    tool_calls: [call],
  });
  const settled = assignToolCallIds(response, [response]);
  assert.notEqual(settled.tool_calls![0].id, call.id);
  const blocks = settled.content as Array<{ type: string; id?: string; input?: unknown }>;
  assert.equal(blocks[1].id, settled.tool_calls![0].id);
  assert.deepEqual(blocks[1].input, call.args);
  assert.equal(blocks[0].type, 'text');
  assert.equal((response.content as Array<{ id?: string }>)[1].id, call.id);
});
