import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createStudioPetModelObserver } from './studio-pet-model-observer.ts';

class ObservedModel extends BaseChatModel {
  constructor(private readonly response: AIMessage, private readonly secret: string) { super({}); }
  _llmType() { return 'observer-test'; }
  invocationParams() {
    return { tools: [{ type: 'function', function: { name: 'submit_plan', description: this.secret } }], apiKey: this.secret };
  }
  async _generate(_messages: BaseMessage[]) {
    return { generations: [{ message: this.response, text: this.response.text,
      generationInfo: { finish_reason: 'tool_calls', headers: { authorization: this.secret } } }],
    llmOutput: { request_id: 'provider-request', private: this.secret } };
  }
}

test('observes the actual model callback input and hides payloads unless synthetic capture is explicit', async () => {
  const identity = randomUUID(), announcement = randomUUID(), privateValue = randomUUID();
  const response = new AIMessage({ content: privateValue,
    tool_calls: [{ id: 'parsed', name: 'submit_plan', args: { objective: privateValue }, type: 'tool_call' }],
    invalid_tool_calls: [{ id: 'invalid', name: 'delegate_capability', args: privateValue, error: privateValue, type: 'invalid_tool_call' }],
    additional_kwargs: { tool_calls: [{ id: 'raw', type: 'function', function: { name: 'submit_plan', arguments: privateValue } }],
      private: privateValue },
    response_metadata: { finish_reason: 'tool_calls', request_id: 'explicit-request', headers: { authorization: privateValue }, private: privateValue },
  });
  const observer = createStudioPetModelObserver({ petRole: 'issuer', sources: [
    { id: 'pet:document', owner: 'pet', content: identity },
    { id: 'channel:context', owner: 'channel', content: announcement },
  ] });
  await new ObservedModel(response, privateValue).invoke([
    new SystemMessage(`${identity}\n${announcement}`), new HumanMessage(privateValue),
  ], { callbacks: [observer.callback], metadata: {
    frameworkComponent: 'run_supervisor', supervisorMode: 'entry', private: privateValue,
  } });
  const records = observer.read();
  assert.equal(records.length, 1);
  const record = records[0]!;
  assert.equal(record.stage, 'supervisor-entry');
  assert.equal(record.petRole, 'issuer');
  assert.equal(record.status, 'completed');
  assert.deepEqual(record.boundToolNames, ['submit_plan']);
  assert.deepEqual(record.prompts[0]!.messages.map(message => message.role), ['system', 'human']);
  assert.deepEqual(record.prompts[0]!.sources.map(source => source.locations), [
    [{ messageIndex: 0, role: 'system', occurrences: 1, representation: 'literal' }],
    [{ messageIndex: 0, role: 'system', occurrences: 1, representation: 'literal' }],
  ]);
  assert.equal(record.responses[0]!.toolCalls[0]!.name, 'submit_plan');
  assert.equal(record.responses[0]!.invalidToolCalls[0]!.name, 'delegate_capability');
  assert.equal(record.responses[0]!.rawToolCalls[0]!.id, 'raw');
  assert.equal(record.responses[0]!.finishReason, 'tool_calls');
  assert.equal(record.responses[0]!.providerRequestId, 'explicit-request');
  for (const marker of [identity, announcement, privateValue]) assert.ok(!JSON.stringify(records).includes(marker));
  assert.ok(record.responses[0]!.invalidToolCalls[0]!.errorSha256);
  record.responses.length = 0;
  assert.equal(observer.read()[0]!.responses.length, 1, 'readers cannot mutate captured evidence');
});

test('synthetic opt-in retains final input and both parsed and invalid native calls without provider configuration', async () => {
  const body = `first ${randomUUID()}\nsecond ${randomUUID()}`;
  const privateProviderValue = randomUUID();
  const response = new AIMessage({ content: 'Synthetic output.',
    tool_calls: [{ id: 'call', name: 'submit_plan', args: { tasks: [] }, type: 'tool_call' }],
    invalid_tool_calls: [{ id: 'invalid', name: 'delegate_capability', args: '{', error: 'Invalid JSON.', type: 'invalid_tool_call' }],
    response_metadata: { headers: { authorization: privateProviderValue } },
  });
  const observer = createStudioPetModelObserver({ petRole: 'reviewer', captureSyntheticContent: true,
    sources: [{ id: 'capability:review', owner: 'review', content: body }] });
  const input = [new SystemMessage('System fixture.'),
    new ToolMessage({ tool_call_id: 'details', content: JSON.stringify({ content: body }) })];
  await new ObservedModel(response, privateProviderValue).invoke(input, { callbacks: [observer.callback],
    metadata: { frameworkComponent: 'run_supervisor', supervisorMode: 'boundary' } });
  const record = observer.read()[0]!;
  assert.equal(record.stage, 'supervisor-boundary');
  assert.deepEqual(record.prompts[0]!.messages.map(message => message.text), input.map(message => message.text));
  assert.deepEqual(record.prompts[0]!.sources[0]!.locations,
    [{ messageIndex: 1, role: 'tool', occurrences: 1, representation: 'json-string' }]);
  assert.deepEqual(record.responses[0]!.toolCalls[0]!.args, { tasks: [] });
  assert.equal(record.responses[0]!.invalidToolCalls[0]!.args, '{');
  assert.equal(record.responses[0]!.invalidToolCalls[0]!.error, 'Invalid JSON.');
  assert.equal(record.responses[0]!.text, 'Synthetic output.');
  assert.equal(record.responses[0]!.providerRequestId, 'provider-request');
  assert.ok(!JSON.stringify(record).includes(privateProviderValue));
});

test('node metadata distinguishes child execution and Entry without interpreting prompt prose', async () => {
  const observer = createStudioPetModelObserver({ petRole: 'executor' });
  const model = new ObservedModel(new AIMessage('Done.'), randomUUID());
  await model.invoke([new HumanMessage(randomUUID())], { callbacks: [observer.callback],
    metadata: { langgraph_node: 'entryAnswer' } });
  await model.invoke([new HumanMessage(randomUUID())], { callbacks: [observer.callback],
    metadata: { langgraph_node: 'model', langgraph_checkpoint_ns: 'capability:task|model:child',
      frameworkComponent: 'run_supervisor', supervisorMode: 'entry' } });
  await model.invoke([new HumanMessage(randomUUID())], { callbacks: [observer.callback] });
  assert.deepEqual(observer.read().map(record => record.stage), ['entry', 'capability', 'unknown']);
});

test('concurrent model callbacks remain correlated and errors do not copy provider messages', async () => {
  const observer = createStudioPetModelObserver({ petRole: 'wiki', defaultStage: 'entry' });
  const secret = randomUUID();
  class FailingModel extends BaseChatModel {
    _llmType() { return 'observer-failure'; }
    async _generate(): Promise<never> { throw new Error(secret); }
  }
  const results = await Promise.allSettled([
    new ObservedModel(new AIMessage('Done.'), secret).invoke([new HumanMessage('A')], { callbacks: [observer.callback] }),
    new FailingModel({}).invoke([new HumanMessage('B')], { callbacks: [observer.callback] }),
  ]);
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected']);
  const records = observer.read();
  assert.equal(new Set(records.map(record => record.runId)).size, 2);
  assert.deepEqual(records.map(record => record.status).sort(), ['completed', 'error']);
  assert.equal(records.find(record => record.status === 'error')!.errorName, 'Error');
  assert.ok(!JSON.stringify(records).includes(secret));
});
