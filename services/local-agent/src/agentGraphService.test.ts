import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { MemorySaver, interrupt } from '@langchain/langgraph';
import { buildOrchestratorRunInput, compileAgentRegistry, getAgentRuntimeContext, createOrchestratorGraph, defineInstructionDocument, runAgent, type AgentModels, type RunSupervisorRunner } from '@pinpawo/pet-agent';
import type { AgentChannelSetup } from './agentChannel';
import { buildAgentGraphConfigurable, LocalAgentGraphService } from './agentGraphService';

function setup(
  interfaceContext?: AgentChannelSetup['interfaceContext'],
): AgentChannelSetup {
  return {
    graphConfig: {},
    registry: { authorizationGeneration: 'test' },
    input: {
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


test('graphs take current common context through run, invokeState and root stream entry points', async () => {
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
  const registry = compileAgentRegistry({ capabilities: [], toolkits: [] });
  const service = new LocalAgentGraphService();
  const tokens = [randomUUID(), randomUUID(), randomUUID()];
  for (const [index, token] of tokens.entries()) {
    const input: AgentChannelSetup = {
      registry,
      graphConfig: { models: { act: model } },
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

test('all invocation entry points preserve scope, trace identity and current metadata', async () => {
  const seen: Array<{ traceId: string; capabilities: readonly string[]; workdir: unknown }> = [];
  const model = {
    invoke: async () => new AIMessage('done'),
    bindTools: () => ({ invoke: async () => new AIMessage({ content: '', tool_calls: [{
      id: randomUUID(), name: 'plan_request', args: { goal: 'inspect' },
    }] }) }),
  } as unknown as AgentModels['act'];
  const runner: RunSupervisorRunner = {
    async invoke(input, config) {
      seen.push({ traceId: input.traceId, capabilities: input.workspace.capabilityNames, workdir: getAgentRuntimeContext(config).workdir });
      assert.equal('actor' in (config?.configurable ?? {}), false);
      assert.ok(config?.signal);
      assert.equal(config?.signal?.aborted, false);
      assert.deepEqual(config?.configurable?.reviewCapabilities, { humanReview: false, sessionAuthorization: true });
      assert.deepEqual(config?.configurable?.globalReviewPolicy, { mode: 'full_access' });
      return { action: 'unavailable', tasks: [] };
    },
  };
  const registry = compileAgentRegistry({ toolkits: [], capabilities: ['first', 'second'].map(name => ({
    name, description: name, uses: [], instructions: defineInstructionDocument({ content: name }),
  })) });
  const graphConfig = { models: { act: model }, runSupervisorRunner: runner, capabilityRegistryBackend: 'memory' as const };
  const service = new LocalAgentGraphService();
  const graph = createOrchestratorGraph(graphConfig);
  for (const path of ['core', 'run', 'invokeState', 'streamEvents']) {
    for (const allowedCapabilityNames of [['first'], []]) {
      const traceId = randomUUID();
      const workdir = `/workspace/${randomUUID()}`;
      const input: AgentChannelSetup = {
        registry, graphConfig,
        input: { messages: [new HumanMessage('inspect')], traceId, allowedCapabilityNames,
          context: { workdir }, signal: new AbortController().signal, globalReviewPolicy: { mode: 'full_access' } },
      };
      if (path === 'core') await runAgent(graph, input.input, { registry, reviewCapabilities: { humanReview: false, sessionAuthorization: true } });
      else if (path === 'run') await service.run(input);
      else if (path === 'invokeState') await service.invokeState(input);
      else {
        const stream = await service.streamEvents(input);
        for await (const _event of stream) { /* Consume the production stream. */ }
        await stream.output;
      }
      assert.deepEqual(seen.at(-1), { traceId, capabilities: allowedCapabilityNames, workdir }, path);
    }
  }
  assert.equal(seen.length, 8);
});

test('local stream resume refreshes invocation metadata while preserving the checkpoint task', async () => {
  const seen: Array<{ traceId: string; workdir: string | null }> = [];
  const model = {
    invoke: async () => new AIMessage('done'),
    bindTools: () => ({ invoke: async () => new AIMessage({ content: '', tool_calls: [{
      id: randomUUID(), name: 'plan_request', args: { goal: 'inspect' },
    }] }) }),
  } as unknown as AgentModels['act'];
  const service = new LocalAgentGraphService();
  const workdirs = [`/workspace/${randomUUID()}`, `/workspace/${randomUUID()}`];
  const traceId = randomUUID();
  const input: AgentChannelSetup = {
    registry: compileAgentRegistry({ toolkits: [], capabilities: [] }),
    graphConfig: {
      models: { act: model }, checkpoint: new MemorySaver(), capabilityRegistryBackend: 'memory',
      runSupervisorRunner: { async invoke(input, config) {
        seen.push({ traceId: input.traceId,
          workdir: getAgentRuntimeContext(config).workdir });
        assert.deepEqual(config?.configurable?.allowedCapabilityNames, []);
        interrupt({ kind: 'invocation-refresh-test' });
        return { action: 'unavailable', tasks: [] };
      } },
    },
    input: { messages: [new HumanMessage('inspect')], threadId: randomUUID(), traceId,
      allowedCapabilityNames: [], context: { workdir: workdirs[0] } },
  };
  await service.invokeState(input);
  assert.equal(seen.length, 1);
  const resumed: AgentChannelSetup = { ...input,
    input: { ...input.input, traceId: randomUUID(), context: { workdir: workdirs[1] } },
  };
  const stream = await service.streamEvents(resumed, service.buildResumeCommand(true));
  for await (const _event of stream) { /* Resume through the production streaming path. */ }
  await stream.output;
  assert.deepEqual(seen, [
    { traceId, workdir: workdirs[0] },
    { traceId, workdir: workdirs[1] },
  ]);
});

test('explicit null input continues the checkpoint task through both execution paths', async () => {
  const seen: BaseMessage[][] = [];
  class Model extends BaseChatModel {
    _llmType() { return 'checkpoint-continuation'; }
    bindTools() { return this; }
    async _generate(messages: BaseMessage[]) {
      seen.push(messages);
      const message = new AIMessage('continued');
      return { generations: [{ message, text: message.text }] };
    }
  }
  const service = new LocalAgentGraphService();
  for (const path of ['stream', 'invoke']) {
    const input: AgentChannelSetup = {
      registry: compileAgentRegistry({ capabilities: [], toolkits: [] }),
      graphConfig: { models: { act: new Model({}) }, checkpoint: new MemorySaver() },
      input: { threadId: randomUUID(), messages: [new HumanMessage('unused new input')] },
    };
    await service.updateState(input, buildOrchestratorRunInput([
      new HumanMessage('checkpointed request'),
    ]), 'captureUserRequest');
    assert.equal((await service.readThreadState(input)).hasPendingContinuation, true);
    if (path === 'stream') {
      const stream = await service.streamEvents(input, null);
      for await (const _event of stream) { /* Consume the resumed task. */ }
      await stream.output;
    } else {
      await service.invokeState(input, null);
    }
    const state = await service.readThreadState(input);
    assert.equal(state.messages.at(-1)?.text, 'continued');
    assert.ok(seen.at(-1)?.some(message => message.text === 'checkpointed request'));
    assert.equal(seen.at(-1)?.some(message => message.text === 'unused new input'), false);
    assert.equal(state.hasPendingContinuation, false);
  }
});

test('graph execution uses replacement models and checkpoint adapters for the same thread', async () => {
  class Model extends BaseChatModel {
    constructor(private readonly reply: string) { super({}); }
    _llmType() { return 'same-model-identity'; }
    bindTools() { return this; }
    async _generate() {
      const message = new AIMessage(this.reply);
      return { generations: [{ message, text: message.text }] };
    }
  }
  const firstCheckpoint = new MemorySaver();
  const secondCheckpoint = new MemorySaver();
  const registry = compileAgentRegistry({ capabilities: [], toolkits: [] });
  const service = new LocalAgentGraphService();
  const input: AgentChannelSetup = {
    registry,
    graphConfig: { models: { act: new Model('first') }, checkpoint: firstCheckpoint },
    input: { threadId: randomUUID(), messages: [new HumanMessage('first request')] },
  };
  assert.equal((await service.run(input)).reply, 'first');

  input.graphConfig.models = { act: new Model('replacement') };
  input.input.messages = [new HumanMessage('second request')];
  const continued = await service.run(input);
  assert.equal(continued.reply, 'replacement');
  assert.ok(continued.messages.some(message => message.text === 'first request'));

  input.graphConfig.checkpoint = secondCheckpoint;
  input.input.messages = [new HumanMessage('separate store')];
  const isolated = await service.run(input);
  assert.equal(isolated.reply, 'replacement');
  assert.equal(isolated.messages.some(message => message.text === 'first request'), false);
  assert.equal(isolated.messages.some(message => message.text === 'second request'), false);

  input.graphConfig.checkpoint = firstCheckpoint;
  const restored = await service.readThreadState(input);
  assert.ok(restored.messages.some(message => message.text === 'first request'));
  assert.ok(restored.messages.some(message => message.text === 'second request'));
  assert.equal(restored.messages.some(message => message.text === 'separate store'), false);
});
