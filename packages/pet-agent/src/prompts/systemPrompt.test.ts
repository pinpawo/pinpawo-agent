import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createAgent } from 'langchain';
import { composeSystemPrompt, createSystemPromptMiddleware, systemPromptMiddleware } from './systemPrompt';
import { invokeOrchestratorModel } from '../agent/orchestrator/modelInvocation';
import { getAgentRuntimeContext } from '../runtime/context';

class RecordingModel extends BaseChatModel {
  readonly invocations: BaseMessage[][] = [];
  _llmType() { return 'system-prompt-recorder'; }
  bindTools() { return this; }
  async _generate(messages: BaseMessage[]) {
    this.invocations.push(messages);
    const message = new AIMessage('done');
    return { generations: [{ message, text: message.text }] };
  }
}

function sections() {
  return [{ id: 'host:first', content: randomUUID() }, { id: 'host:second', content: randomUUID() }];
}

test('composition preserves role content blocks, metadata and input identity', () => {
  const role = new SystemMessage({
    id: 'system-id', name: 'role-owner',
    content: [
      { type: 'text', text: randomUUID(), cache_control: { type: 'ephemeral' } },
      { type: 'text', text: randomUUID(), annotations: [{ owner: 'role' }] },
    ],
    additional_kwargs: { provider: { feature: true } },
    response_metadata: { revision: 3 },
  });
  const original = role.toDict();
  const common = sections();
  const local = [{ id: 'execution:one', content: randomUUID() }];
  const composed = composeSystemPrompt(role, { systemPromptSections: common }, local);
  assert.notEqual(composed, role);
  assert.deepEqual(role.toDict(), original);
  assert.equal(composed.id, role.id);
  assert.equal(composed.name, role.name);
  assert.deepEqual(composed.additional_kwargs, role.additional_kwargs);
  assert.deepEqual(composed.response_metadata, role.response_metadata);
  assert.deepEqual((composed.content as unknown[]).slice(0, 2), role.content);
  assert.equal(composed.text, [role.text, ...common.map(s => s.content), ...local.map(s => s.content)].join('\n\n'));
  assert.equal(composeSystemPrompt(role), role);
});

test('direct and Agent calls use the same ordering without persisting common context', async () => {
  const role = new SystemMessage(randomUUID());
  const common = sections();
  const config = { context: { systemPromptSections: common } };
  const model = new RecordingModel({});
  const agent = createAgent({ model, tools: [], systemPrompt: role, middleware: [systemPromptMiddleware] });
  await invokeOrchestratorModel(model, { systemMessage: role, messages: [new HumanMessage('first')] }, config);
  let result = await agent.invoke({ messages: [new HumanMessage('second')] }, config);
  result = await agent.invoke({ messages: [...result.messages, new HumanMessage('third')] }, config);
  assert.equal(model.invocations.length, 3);
  const expected = [role.text, ...common.map(s => s.content)].join('\n\n');
  for (const invocation of model.invocations) {
    assert.equal(invocation[0].text, expected);
    assert.equal(invocation.filter(SystemMessage.isInstance).length, 1);
  }
  const withoutRole = createAgent({ model, tools: [], middleware: [systemPromptMiddleware] });
  await withoutRole.invoke({ messages: [new HumanMessage('no explicit role')] }, config);
  assert.equal(model.invocations.at(-1)?.[0].text, common.map(s => s.content).join('\n\n'));
  assert.equal(result.messages.some(SystemMessage.isInstance), false);
  for (const section of common) assert.equal(JSON.stringify(result.messages).includes(section.content), false);
});

test('all composition paths reject empty and colliding sections before calling a model', async () => {
  const invalidSections = [
    [{ id: '', content: 'data' }],
    [{ id: 'host:empty', content: '  ' }],
    [{ id: 'host:one', content: 'one' }, { id: ' host:one ', content: 'two' }],
  ];
  for (const systemPromptSections of invalidSections) {
    const role = new SystemMessage('role');
    const model = new RecordingModel({});
    const agent = createAgent({ model, tools: [], systemPrompt: role, middleware: [systemPromptMiddleware] });
    assert.throws(() => composeSystemPrompt(role, { systemPromptSections }));
    await assert.rejects(async () => invokeOrchestratorModel(model, {
      systemMessage: role, messages: [new HumanMessage('test')],
    }, { context: { systemPromptSections } }));
    await assert.rejects(agent.invoke({ messages: [new HumanMessage('test')] }, { context: { systemPromptSections } }));
    assert.equal(model.invocations.length, 0);
  }
  const model = new RecordingModel({});
  const common = sections();
  const agent = createAgent({
    model, tools: [], systemPrompt: 'role', middleware: [createSystemPromptMiddleware([common[0]])],
  });
  await assert.rejects(agent.invoke({ messages: [new HumanMessage('test')] }, {
    context: { systemPromptSections: common },
  }), /Duplicate system prompt section id/);
  assert.equal(model.invocations.length, 0);
});

test('runtime context snapshots common sections and has no configurable fallback', () => {
  const source = sections();
  const snapshot = getAgentRuntimeContext({ context: { systemPromptSections: source } });
  source[0].content = randomUUID();
  assert.notEqual(snapshot.systemPromptSections?.[0].content, source[0].content);
  assert.equal(Object.isFrozen(snapshot.systemPromptSections), true);
  assert.equal(Object.isFrozen(snapshot.systemPromptSections?.[0]), true);
  assert.deepEqual(getAgentRuntimeContext({ configurable: { systemPromptSections: source } }), { workdir: null, systemPromptSections: [] });
});

test('workdir is rendered once from typed context across direct and middleware calls', async () => {
  const workdir = `/workspace/${randomUUID()}`;
  const model = new RecordingModel({});
  const role = new SystemMessage('role');
  const context = getAgentRuntimeContext({ context: { workdir } });
  await invokeOrchestratorModel(model, { systemMessage: role, messages: [new HumanMessage('first')] }, { context });
  const agent = createAgent({ model, tools: [], systemPrompt: role, middleware: [systemPromptMiddleware] });
  await agent.invoke({ messages: [new HumanMessage('second')] }, { context });
  for (const input of model.invocations) assert.equal(input[0].text.split(workdir).length - 1, 1);
  assert.equal(model.invocations[0][0].text, model.invocations[1][0].text);
  assert.equal(getAgentRuntimeContext({ configurable: { workdir } }).workdir, null);
  assert.throws(() => getAgentRuntimeContext({ context: { workdir: '   ' } }));
  assert.equal(getAgentRuntimeContext({ context: { workdir: `${workdir} ` } }).workdir, `${workdir} `);
  assert.throws(() => composeSystemPrompt(role, {
    workdir, systemPromptSections: [{ id: 'framework:workdir', content: 'conflict' }],
  }), /Duplicate system prompt section id/);
});
