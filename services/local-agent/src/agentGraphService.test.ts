import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { compileAgentRegistry } from '@pinpawo/pet-agent';
import type { AgentChannelSetup } from './agentChannel';
import { buildAgentGraphConfigurable, LocalAgentGraphService } from './agentGraphService';

function setup(
  interfaceContext?: AgentChannelSetup['interfaceContext'],
): AgentChannelSetup {
  return {
    graphKey: 'test',
    graphConfig: {},
    registry: { authorizationGeneration: 'test' },
    input: {
      actor: { petId: 'pet', userId: null, name: 'Pet' },
      messages: [],
      threadId: 'thread',
    },
    ...(interfaceContext ? { interfaceContext } : {}),
  } as unknown as AgentChannelSetup;
}

test('headless graph sessions keep checkpointed authorization without human review', () => {
  const configurable = buildAgentGraphConfigurable(setup());

  assert.deepEqual(configurable?.reviewCapabilities, {
    humanReview: false,
    sessionAuthorization: true,
  });
});

test('interactive graph sessions use interface-provided review capabilities', () => {
  const configurable = buildAgentGraphConfigurable(setup({
    kind: 'app_chat',
    threadId: 'thread',
    capabilities: {
      humanReview: true,
      sessionAuthorization: true,
    },
  } as unknown as AgentChannelSetup['interfaceContext']));

  assert.deepEqual(configurable?.reviewCapabilities, {
    humanReview: true,
    sessionAuthorization: true,
  });
});


test('cached graphs take current common context through run, invokeState and root stream entry points', async () => {
  const seen: BaseMessage[][] = [];
  class Model extends BaseChatModel {
    _llmType() { return 'local-context-recorder'; }
    bindTools() { return this; }
    async _generate(messages: BaseMessage[]) {
      seen.push(messages);
      const message = new AIMessage('done');
      return { generations: [{ message, text: message.text }] };
    }
  }
  const model = new Model({});
  const actor = { petId: 'pet-context', userId: null, name: 'Pet', species: null, stage: null, personality: null };
  const registry = compileAgentRegistry({ capabilities: [], toolkits: [] });
  const service = new LocalAgentGraphService();
  const tokens = [randomUUID(), randomUUID(), randomUUID()];
  for (const [index, token] of tokens.entries()) {
    const input: AgentChannelSetup = {
      graphKey: 'shared-context-test', registry,
      graphConfig: { models: { act: model }, actor },
      input: { messages: [new HumanMessage('hello')], context: { systemPromptSections: [{ id: 'host:pet', content: token }] } },
    };
    if (index === 0) await service.run(input);
    else if (index === 1) await service.invokeState(input);
    else {
      const stream = await service.streamEvents(input);
      for await (const _event of stream) { /* Consume the root stream. */ }
      await stream.output;
    }
    assert.equal(seen.length, index + 1);
    assert.equal(seen[index][0].text.split(token).length - 1, 1);
    for (const other of tokens.filter(value => value !== token)) assert.equal(seen[index][0].text.includes(other), false);
  }
});
