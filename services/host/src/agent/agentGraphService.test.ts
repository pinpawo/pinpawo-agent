import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { MemorySaver, interrupt } from '@langchain/langgraph';
import { buildOrchestratorRunInput, buildReviewSpec, compileAgentRegistry, getAgentRuntimeContext, createOrchestratorGraph, defineInstructionDocument, runAgent, type AgentModels, type OrchestratorGraph, type RunSupervisorRunner } from '@pinpawo/pet-agent';
import type { AgentChannelSetup } from './agentChannel';
import { buildAgentGraphConfigurable, HostGraphService, type InterruptResume } from './agentGraphService';
import { scriptedSupervisorResult } from '../../../../packages/pet-agent/src/agent/orchestrator/runSupervisor/testing';

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

/**
 * Drive one run to completion through the service's public entry point.
 * `run()` and `invokeState()` are gone, so every execution assertion below
 * goes through the same root stream production uses.
 */
async function runToCompletion(
  service: HostGraphService,
  setup: AgentChannelSetup,
  resume?: InterruptResume,
) {
  const stream = await service.streamEvents(setup, resume);
  for await (const _event of stream) { /* Consume the root stream. */ }
  await stream.output;
}

test('graphs take current common context through the root stream entry point', async () => {
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
  const service = new HostGraphService();
  const tokens = [randomUUID(), randomUUID(), randomUUID()];
  for (const [index, token] of tokens.entries()) {
    const input: AgentChannelSetup = {
      registry,
      graphConfig: { models: { act: model } },
      input: { messages: [new HumanMessage('hello')], context: { systemPromptSections: [{ id: 'host:pet', content: token }] } },
    };
    await runToCompletion(service, input);
    assert.equal(seen.length, index + 1);
    assert.equal(seen[index][0].text.split(token).length - 1, 1);
    for (const other of tokens.filter(value => value !== token)) assert.equal(seen[index][0].text.includes(other), false);
  }
});

test('all invocation entry points preserve scope, trace identity and current metadata', async () => {
  const seen: Array<{ taskId: string; capabilities: readonly string[]; workdir: unknown }> = [];
  const model = {
    invoke: async () => new AIMessage('done'),
    bindTools: () => ({ invoke: async () => new AIMessage({ content: '', tool_calls: [{
      id: randomUUID(), name: 'plan_request', args: { goal: 'inspect' },
    }] }) }),
  } as unknown as AgentModels['act'];
  const runner: RunSupervisorRunner = {
    async invoke(input, config) {
      seen.push({ taskId: input.taskId, capabilities: input.catalog.capabilityNames, workdir: getAgentRuntimeContext(config).workdir });
      assert.equal('actor' in (config?.configurable ?? {}), false);
      assert.ok(config?.signal);
      assert.equal(config?.signal?.aborted, false);
      assert.deepEqual(config?.configurable?.reviewCapabilities, { humanReview: false, sessionAuthorization: true });
      assert.deepEqual(config?.configurable?.globalReviewPolicy, { mode: 'full_access' });
      return scriptedSupervisorResult(input, { reply: 'No execution available.' });
    },
  };
  const registry = compileAgentRegistry({ toolkits: [], capabilities: ['first', 'second'].map(name => ({
    name, description: name, uses: [], instructions: defineInstructionDocument({ content: name }),
  })) });
  const graphConfig = { models: { act: model }, runSupervisorRunner: runner };
  const service = new HostGraphService();
  const graph = createOrchestratorGraph(graphConfig);
  for (const path of ['core', 'streamEvents']) {
    for (const allowedCapabilityNames of [['first'], []]) {
      const taskId = randomUUID();
      const workdir = `/workspace/${randomUUID()}`;
      const input: AgentChannelSetup = {
        registry, graphConfig,
        input: { messages: [new HumanMessage('inspect')], taskId, allowedCapabilityNames,
          context: { workdir }, signal: new AbortController().signal, globalReviewPolicy: { mode: 'full_access' } },
      };
      if (path === 'core') await runAgent(graph, input.input, { registry, reviewCapabilities: { humanReview: false, sessionAuthorization: true } });
      else await runToCompletion(service, input);
      assert.deepEqual(seen.at(-1), { taskId, capabilities: allowedCapabilityNames, workdir }, path);
    }
  }
  assert.equal(seen.length, 4);
});

test('local stream resume refreshes invocation metadata while preserving the checkpoint task', async () => {
  const seen: Array<{ taskId: string; workdir: string | null }> = [];
  const model = {
    invoke: async () => new AIMessage('done'),
    bindTools: () => ({ invoke: async () => new AIMessage({ content: '', tool_calls: [{
      id: randomUUID(), name: 'plan_request', args: { goal: 'inspect' },
    }] }) }),
  } as unknown as AgentModels['act'];
  const service = new HostGraphService();
  const workdirs = [`/workspace/${randomUUID()}`, `/workspace/${randomUUID()}`];
  const taskId = randomUUID();
  const input: AgentChannelSetup = {
    registry: compileAgentRegistry({ toolkits: [], capabilities: [] }),
    graphConfig: {
      models: { act: model }, checkpoint: new MemorySaver(),
      runSupervisorRunner: { async invoke(input, config) {
        seen.push({ taskId: input.taskId,
          workdir: getAgentRuntimeContext(config).workdir });
        assert.deepEqual(config?.configurable?.allowedCapabilityNames, []);
        interrupt({ kind: 'review', review: buildReviewSpec({ id: 'invocation-review',
          view: { kind: 'plain', body: 'Review invocation?' },
          options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }],
        }) });
        return scriptedSupervisorResult(input, { reply: 'No execution available.' });
      } },
    },
    input: { messages: [new HumanMessage('inspect')], threadId: randomUUID(), taskId,
      allowedCapabilityNames: [], context: { workdir: workdirs[0] } },
  };
  const initial = await service.streamEvents(input);
  for await (const _event of initial) { /* Reach the interrupt. */ }
  await initial.output;
  assert.equal(seen.length, 1);
  const resumed: AgentChannelSetup = { ...input,
    input: { ...input.input, taskId: randomUUID(), context: { workdir: workdirs[1] } },
  };
  // Read the original native review identity from the rebuilt checkpoint.
  const graph = createOrchestratorGraph(input.graphConfig);
  const snapshot = await graph.getState({
    configurable: buildAgentGraphConfigurable(input),
  });
  const interruptId = snapshot.tasks.flatMap(
    (task) => task.interrupts ?? [],
  )[0]?.id ?? '';
  assert.ok(interruptId, 'the fixture must leave an interrupt to resume');
  const stream = await service.streamEvents(resumed, {
    interruptId,
    value: true,
  });
  for await (const _event of stream) { /* Resume through the production streaming path. */ }
  await stream.output;
  assert.deepEqual(seen, [
    { taskId, workdir: workdirs[0] },
    { taskId, workdir: workdirs[1] },
  ]);
});

test('a settlement with nothing to continue leaves the committed task alone', async () => {
  // An abort that left no pending delegation is not a pause: settling reports
  // no interrupt and must not advance the thread on its own.
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
  const service = new HostGraphService();
  const input: AgentChannelSetup = {
    registry: compileAgentRegistry({ capabilities: [], toolkits: [] }),
    graphConfig: { models: { act: new Model({}) }, checkpoint: new MemorySaver() },
    input: { threadId: randomUUID(), messages: [new HumanMessage('unused new input')] },
  };
  await service.updateState(input, buildOrchestratorRunInput([
    new HumanMessage('checkpointed request'),
  ]), 'captureUserRequest');
  assert.equal((await service.readThreadState(input)).acceptsResume, true);

  assert.equal(await service.settleAbortedRun(input), null);

  // The committed task is still there to continue, and no model ran.
  assert.deepEqual(seen, []);
  assert.equal((await service.readThreadState(input)).acceptsResume, true);
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
  const service = new HostGraphService();
  const input: AgentChannelSetup = {
    registry,
    graphConfig: { models: { act: new Model('first') }, checkpoint: firstCheckpoint },
    input: { threadId: randomUUID(), messages: [new HumanMessage('first request')] },
  };
  await runToCompletion(service, input);
  assert.equal((await service.readThreadState(input)).messages.at(-1)?.text, 'first');

  input.graphConfig.models = { act: new Model('replacement') };
  input.input.messages = [new HumanMessage('second request')];
  await runToCompletion(service, input);
  const continued = await service.readThreadState(input);
  assert.equal(continued.messages.at(-1)?.text, 'replacement');
  assert.ok(continued.messages.some(message => message.text === 'first request'));

  input.graphConfig.checkpoint = secondCheckpoint;
  input.input.messages = [new HumanMessage('separate store')];
  await runToCompletion(service, input);
  const isolated = await service.readThreadState(input);
  assert.equal(isolated.messages.at(-1)?.text, 'replacement');
  assert.equal(isolated.messages.some(message => message.text === 'first request'), false);
  assert.equal(isolated.messages.some(message => message.text === 'second request'), false);

  input.graphConfig.checkpoint = firstCheckpoint;
  const restored = await service.readThreadState(input);
  assert.ok(restored.messages.some(message => message.text === 'first request'));
  assert.ok(restored.messages.some(message => message.text === 'second request'));
  assert.equal(restored.messages.some(message => message.text === 'separate store'), false);
});

test('usage callbacks persist absolute session totals across turns and checkpoint reload', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { FileSaver } = await import('../fileSaver');
  const directory = mkdtempSync(join(tmpdir(), 'graph-usage-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'checkpoints.json');
  class UsageModel extends BaseChatModel {
    _llmType() { return 'local-usage-fixture'; }
    bindTools() { return this; }
    async _generate() {
      const message = new AIMessage({ content: 'done', usage_metadata: {
        input_tokens: 100, output_tokens: 20, total_tokens: 120, input_token_details: { cache_read: 50 },
      } });
      return { generations: [{ message, text: 'done' }] };
    }
  }
  const service = new HostGraphService();
  const model = new UsageModel({});
  const input: AgentChannelSetup = {
    registry: compileAgentRegistry({ capabilities: [], toolkits: [] }),
    graphConfig: { models: { act: model }, checkpoint: new FileSaver(path) },
    input: { threadId: 'usage-session', messages: [new HumanMessage('hello')] },
  };
  const observed: number[] = [];
  for (let turn = 1; turn <= 2; turn++) {
    const stream = await service.streamEvents(input, undefined, usage => observed.push(usage.totalTokens));
    for await (const _event of stream) { /* Drain a real graph with a local model. */ }
    await stream.output;
    const state = await service.readThreadState(input);
    assert.equal(state.sessionTokenUsage?.totalTokens, 120 * turn);
    assert.equal(state.sessionTokenUsage?.cachedInputTokens, 50 * turn);
    assert.equal(state.sessionTokenUsage?.outputTokensPerSecond, undefined);
    input.graphConfig.checkpoint = new FileSaver(path);
  }
  assert.deepEqual(observed, [0, 120, 120, 240]);
});

test('third-party checkpointers keep live accounting and rebuild a clearly incomplete baseline after Host replacement', async () => {
  class UsageModel extends BaseChatModel {
    _llmType() { return 'transient-usage-fixture'; }
    bindTools() { return this; }
    async _generate() {
      const message = new AIMessage({ content: 'done', usage_metadata: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } });
      return { generations: [{ text: 'done', message }] };
    }
  }
  // A partial duck type is not the usage-store interface and must fall back.
  const checkpoint = Object.assign(new MemorySaver(), { readSessionUsage() { throw new Error('must not be used'); } });
  const setup: AgentChannelSetup = {
    registry: compileAgentRegistry({ capabilities: [], toolkits: [] }),
    graphConfig: { models: { act: new UsageModel({}) }, checkpoint },
    input: { threadId: 'transient-thread', messages: [new HumanMessage('hello')] },
  };
  let service = new HostGraphService();
  let firstEpoch: string | undefined;
  for (let turn = 1; turn <= 3; turn++) {
    if (turn === 3) service = new HostGraphService();
    const observed: number[] = [];
    const stream = await service.streamEvents(setup, undefined, usage => observed.push(usage.totalTokens));
    for await (const _event of stream) { /* Local model only. */ }
    await stream.output;
    const usage = (await service.readThreadState(setup)).sessionTokenUsage;
    assert.equal(usage?.totalTokens, turn * 120);
    assert.equal(usage?.incomplete, true);
    assert.equal(observed.at(-1), turn * 120);
    if (turn === 1) firstEpoch = usage?.usageEpoch;
    if (turn === 2) assert.equal(usage?.usageEpoch, firstEpoch);
    if (turn === 3) assert.notEqual(usage?.usageEpoch, firstEpoch);
  }
});
