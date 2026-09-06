import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { MemorySaver, interrupt } from '@langchain/langgraph';
import { compileAgentRegistry, getAgentRuntimeContext, createOrchestratorGraph, defineInstructionDocument, runAgent, type AgentModels, type OrchestratorGraph, type RunSupervisorRunner } from '@pinpawo/pet-agent';
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
  const registry = compileAgentRegistry({ capabilities: [], toolkits: [] });
  const service = new LocalAgentGraphService();
  const tokens = [randomUUID(), randomUUID(), randomUUID()];
  for (const [index, token] of tokens.entries()) {
    const input: AgentChannelSetup = {
      graphKey: 'shared-context-test', registry,
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
        graphKey: 'same-cached-graph', registry, graphConfig,
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
    graphKey: randomUUID(), registry: compileAgentRegistry({ toolkits: [], capabilities: [] }),
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

test('explicit null input continues the current LangGraph task', async () => {
  const streamInputs: unknown[] = [];
  const invokeInputs: unknown[] = [];
  const graph = {
    async streamEvents(input: unknown) {
      streamInputs.push(input);
      return {};
    },
    async invoke(input: unknown) {
      invokeInputs.push(input);
      return {};
    },
  } as unknown as OrchestratorGraph;
  const service = new LocalAgentGraphService();
  const graphs = (service as unknown as {
    graphs: Map<string, OrchestratorGraph>;
  }).graphs;
  graphs.set('test', graph);

  await service.streamEvents(setup(), null);
  await service.invokeState(setup(), null);

  assert.deepEqual(streamInputs, [null]);
  assert.deepEqual(invokeInputs, [null]);
});
