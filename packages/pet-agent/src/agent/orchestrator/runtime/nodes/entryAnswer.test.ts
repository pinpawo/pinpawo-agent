import { createDeliveryResult, withDeliveryCalls } from '../../../../testing/capabilityDelivery';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { MemorySaver } from '@langchain/langgraph';
import { runAgent } from '../../../runAgent';
import assert from 'node:assert/strict';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { defineInstructionDocument, type AgentCapability } from '../../../../types/capability';
import type { AgentRuntimeContext } from '../../../../runtime/context';
import { composeSystemPrompt } from '../../../../prompts/systemPrompt';
import { compileAgentRegistry } from '../../registry';
import { buildEntryAnswerSystemPrompt } from '../../prompts';
import type { RunSupervisorInput } from '../../runSupervisor/runner';
import { buildOrchestratorRunInput } from '../../state';
import type { OrchestratorStateType } from '../../state';
import type { OrchestratorConfig } from '../../types';
import { createOrchestratorGraph as createRuntimeGraph } from '../graph';
import { withScriptedDelegation, type ScriptedSupervisorRunner } from '../../runSupervisor/testing';

function createOrchestratorGraph(config: Omit<OrchestratorConfig, 'runSupervisorRunner'> & { runSupervisorRunner?: ScriptedSupervisorRunner }) {
  return createRuntimeGraph({ ...config, runSupervisorRunner: config.runSupervisorRunner ? withScriptedDelegation(config.runSupervisorRunner) : undefined });
}
import { captureRunUserRequest, createContinueTool, createPlanRequestTool, entryPlanMessage, PLAN_REQUEST_TOOL_NAME } from './entryAnswer';
import { createContextCompactionMessage } from '../../contextCompaction';
import {
  mainConversationMessages,
  setAgentMessageMetadata,
} from '../../../messages';

/** Read the facts back out of the <supervisor_snapshot> projection. */
function readSnapshot(text: string) {
  const origin = text.match(/origin="([^"]+)"/);
  if (!origin) throw new Error(`Not a supervisor snapshot: ${text}`);
  const goal = text.match(/<goal>\s*<!\[CDATA\[\s*([\s\S]*?)\s*\]\]>/);
  const plan = [...text.matchAll(
    /<item capability="([^"]+)" status="([^"]+)">\s*<objective>\s*<!\[CDATA\[\s*([\s\S]*?)\s*\]\]>/g,
  )].map(([, capability, status, objective]) => ({ capability, status, objective }));
  return { origin: origin[1], goal: goal ? goal[1] : null, plan };
}

function readCapabilityManifest(text: string) {
  const manifest = text.match(/<capability_routing_manifest\b([^>]*)>([\s\S]*?)<\/capability_routing_manifest>/);
  assert.ok(manifest, 'Entry must receive the current capability manifest.');
  return {
    defaultCapabilityName: manifest[1].match(/\bdefault="([^"]+)"/)?.[1],
    capabilities: [...manifest[2].matchAll(/<capability name="([^"]+)">([\s\S]*?)<\/capability>/g)].map(([, name, body]) => ({
      name,
      purpose: body.match(/<purpose>\s*<!\[CDATA\[\s*([\s\S]*?)\s*\]\]>/)?.[1],
      toolkits: [...body.matchAll(/<toolkit name="([^"]+)">([\s\S]*?)<\/toolkit>/g)].map(([, toolkitName, toolkitBody]) => ({
        name: toolkitName,
        description: toolkitBody.match(/<description>\s*<!\[CDATA\[\s*([\s\S]*?)\s*\]\]>/)?.[1],
      })),
    })),
  };
}

function entryCapability(): AgentCapability {
  return {
    name: `cap_${randomUUID().replaceAll('-', '')}`,
    description: randomUUID(),
    uses: [],
    instructions: defineInstructionDocument({ content: randomUUID() }),
  };
}

type EntryRoutingTool = ReturnType<typeof createPlanRequestTool> | ReturnType<typeof createContinueTool>;

function entryToolDescriptions(tools: readonly EntryRoutingTool[]) {
  return tools.map(({ name, description, schema }) => ({
    name, description, goalDescription: schema.shape.goal.description,
  }));
}

function observeEntryBindings(respond: (messages: BaseMessage[]) => AIMessage) {
  const invocations: Array<{ messages: BaseMessage[]; tools: EntryRoutingTool[]; options: unknown }> = [];
  const model = {
    bindTools: (tools: EntryRoutingTool[], options: unknown) => ({
      invoke: async (messages: BaseMessage[]) => {
        invocations.push({ messages, tools, options });
        return respond(messages);
      },
    }),
  } as unknown as BaseChatModel;
  return { model, invocations };
}



function readLatestHumanText(messages: BaseMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?._getType() !== 'human') continue;
    const text = typeof message.content === 'string' ? message.content : message.text;
    if (text.trim()) return text;
  }
  return 'Execute the requested task.';
}

function entryAnswerModel(
  mode: 'direct' | 'plan',
  onEntryInvoke?: (messages: BaseMessage[]) => void,
  planGoal?: string,
  onAnswerInvoke?: (messages: BaseMessage[]) => void,
) {
  let boundCalls = 0;
  let resultCalls = 0;
  const model = {
    bindTools: () => ({
      invoke: async (messages: BaseMessage[]) => {
        boundCalls += 1;
        onEntryInvoke?.(messages);
        return mode === 'plan'
          ? new AIMessage({
              content: '',
              tool_calls: [{
                id: 'call-plan-request',
                name: PLAN_REQUEST_TOOL_NAME,
                // Default to echoing the current request, as a real model does
                // when it already states the goal; planGoal covers the
                // continuation-utterance case.
                args: { goal: planGoal ?? readLatestHumanText(messages) },
              }],
            })
          : new AIMessage('可以，现有信息足够直接回答。');
      },
    }),
    invoke: async (messages: BaseMessage[]) => {
      onAnswerInvoke?.(messages);
      resultCalls += 1;
      return new AIMessage('当前没有可用的 Capability。');
    },
  } as unknown as BaseChatModel;
  return {
    model,
    counts: () => ({ boundCalls, resultCalls }),
  };
}

function invokeConfig() {
  return {
    configurable: {
      thread_id: 'entry-answer-test',
      registry: compileAgentRegistry({ capabilities: [], toolkits: [] }),
    },
  };
}

test('entry capture resolves the fresh request without clearing saved business progress', () => {
  const input = {
    ...buildOrchestratorRunInput([new HumanMessage('继续。')], { taskId: 'new-trace' }),
    runSupervisorState: { goal: '完成两项工作', plan: [
      { id: 'a', capability: 'general', objective: 'First', status: 'completed' },
      { id: 'b', capability: 'general', objective: 'Second', status: 'pending' },
    ] },
  } as unknown as OrchestratorStateType;
  assert.deepEqual(captureRunUserRequest(input), { runUserRequest: '继续。' });
  assert.equal(input.runSupervisorState.plan[0].status, 'completed');
  assert.equal(input.runSupervisorState.plan[1].status, 'pending');
});

test('Entry Answer returns an ordinary reply without invoking Supervisor', async () => {
  const scripted = entryAnswerModel('direct');
  let plannerCalls = 0;
  const graph = createOrchestratorGraph({
    models: { act: scripted.model, answer: scripted.model },
    runSupervisorRunner: {
      async invoke() {
        plannerCalls += 1;
        return {
          reply: '当前没有可用的 Capability。',
        };
      },
    },
  });

  const result = await graph.invoke(
    buildOrchestratorRunInput([new HumanMessage('这个方案还有更好的选择吗？')]),
    invokeConfig(),
  );

  assert.deepEqual(scripted.counts(), { boundCalls: 1, resultCalls: 0 });
  assert.equal(plannerCalls, 0);
  assert.equal(result.runUserRequest, '这个方案还有更好的选择吗？');
  assert.deepEqual(
    result.messages.map((message) => message.content),
    ['这个方案还有更好的选择吗？', '可以，现有信息足够直接回答。'],
  );
});

test('plan_request commits its routing pair to Root before Supervisor reads it', async () => {
  const scripted = entryAnswerModel('plan');
  const supervisorInputs: RunSupervisorInput[] = [];
  const graph = createOrchestratorGraph({
    models: { act: scripted.model, answer: scripted.model },
    runSupervisorRunner: {
      async invoke(input) {
        supervisorInputs.push(input);
        return {
          reply: '当前没有可用的 Capability。',
        };
      },
    },
  });
  const request = '读取仓库文件并检查当前实现。';

  const result = await graph.invoke(
    buildOrchestratorRunInput([new HumanMessage(request)]),
    invokeConfig(),
  );

  assert.deepEqual(scripted.counts(), { boundCalls: 1, resultCalls: 0 });
  assert.equal(supervisorInputs[0]?.userRequest, request);
  assert.equal(supervisorInputs[0]?.messages.some((message) => message.content === request), true);
  assert.equal(result.runUserRequest, request);
  assert.equal(result.messages.some((message) => ToolMessage.isInstance(message) && message.name === PLAN_REQUEST_TOOL_NAME), true);
  assert.equal(result.messages.some((message) => (
    AIMessage.isInstance(message)
    && message.tool_calls?.some((call) => call.name === PLAN_REQUEST_TOOL_NAME)
  )), true);
  assert.equal(result.messages.at(-1)?.content, '当前没有可用的 Capability。');
});

test('Entry routes the goal while runtime hints reach Supervisor independently and expire on the next run', async () => {
  const hints = [
    { source: randomUUID(), instruction: randomUUID(), focus: randomUUID() },
    undefined,
    { source: randomUUID(), instruction: randomUUID() },
  ];
  const goals = hints.map(() => randomUUID());
  let index = 0;
  const observed = observeEntryBindings(() => new AIMessage({ content: '', tool_calls: [{
    id: randomUUID(), name: PLAN_REQUEST_TOOL_NAME, args: { goal: goals[index] },
  }] }));
  const supervisorInputs: RunSupervisorInput[] = [];
  const graph = createOrchestratorGraph({
    models: { act: observed.model, answer: observed.model }, checkpoint: new MemorySaver(),
    runSupervisorRunner: { async invoke(input) { supervisorInputs.push(input); return { reply: randomUUID() }; } },
  });
  for (; index < hints.length; index += 1) {
    const result = await graph.invoke(buildOrchestratorRunInput([new HumanMessage(randomUUID())]), {
      ...invokeConfig(), ...(hints[index] ? { context: { hint: hints[index] } } : {}),
    });
    const input = supervisorInputs[index];
    assert.deepEqual(input.hint, hints[index]);
    assert.equal('hint' in input, hints[index] !== undefined);
    assert.equal(input.userRequest, goals[index]);
    assert.equal(result.runUserRequest, goals[index]);
    const invocation = observed.invocations[index];
    assert.deepEqual(entryToolDescriptions(invocation.tools), entryToolDescriptions([
      createPlanRequestTool(), createContinueTool(),
    ]));
    assert.equal(invocation.messages[0].text, buildEntryAnswerSystemPrompt(false));
    const hintMessages = invocation.messages.filter(message => message.text.startsWith('<invocation_hint '));
    assert.equal(hintMessages.length, hints[index] ? 1 : 0);
    for (const [hintIndex, hint] of hints.entries()) {
      if (!hint) continue;
      for (const value of Object.values(hint)) {
        assert.equal(invocation.messages.some(message => message.text.includes(value)), hintIndex === index);
        assert.equal(result.messages.some(message => message.text.includes(value)), false);
        assert.equal(input.userRequest.includes(value), false);
      }
    }
  }
});

test('plan_request retires the saved plan so Supervisor plans the new request from empty', async () => {
  const scripted = entryAnswerModel('plan');
  const supervisorInputs: RunSupervisorInput[] = [];
  const graph = createOrchestratorGraph({
    models: { act: scripted.model, answer: scripted.model },
    runSupervisorRunner: { async invoke(input) { supervisorInputs.push(input); return { reply: '已收到。' }; } },
  });
  const saved = { runId: 'earlier-run', goal: 'Plan the trip.', plan: [
    { id: 'done', capability: 'general', objective: 'Book the flight.', status: 'completed' as const },
    { id: 'open', capability: 'general', objective: 'Book the hotel.', status: 'pending' as const },
  ] };
  await graph.invoke({ ...buildOrchestratorRunInput([new HumanMessage('读取仓库文件并检查当前实现。')]), runSupervisorState: saved }, invokeConfig());
  assert.equal(supervisorInputs[0]?.mode, 'entry');
  assert.deepEqual(supervisorInputs[0]?.state, { runId: null, goal: null, plan: [] });
});

for (const { scenario, hasExternalContext } of (['keep', 'widen'] as const)
  .flatMap(scenario => [false, true].map(hasExternalContext => ({ scenario, hasExternalContext })))) {
  test(`continue adopts the saved plan and ${scenario === 'keep' ? 'keeps' : 'replaces'} its goal with external context ${hasExternalContext}`, async () => {
    const supervisorInputs: RunSupervisorInput[] = [];
    const widened = 'Plan the trip and book the restaurant.';
    const model = { bindTools: () => ({ invoke: async () => new AIMessage({ content: '', tool_calls: [{
      id: 'continue', name: 'continue', args: scenario === 'widen' ? { goal: widened } : {},
    }] }) }) } as unknown as BaseChatModel;
    const graph = createOrchestratorGraph({ models: { act: model, answer: model },
      runSupervisorRunner: { async invoke(input) { supervisorInputs.push(input); return { reply: '继续。' }; } } });
    const saved = { runId: 'earlier-run', goal: 'Plan the trip.', adjustedGoal: 'Plan the Kyoto leg.', plan: [
      { id: 'open', capability: 'general', objective: 'Book the hotel.', status: 'pending' as const },
    ] };
    const output = await graph.invoke({ ...buildOrchestratorRunInput([new HumanMessage('接着做，顺便订餐厅。')]),
      runSupervisorState: saved }, {
      ...invokeConfig(),
      ...(hasExternalContext ? { context: { workdir: null, systemPromptSections: [{ id: randomUUID(), content: randomUUID() }] } } : {}),
    });
    const state = supervisorInputs[0]!.state;
    assert.equal(supervisorInputs[0]?.mode, 'boundary');
    assert.equal(state.runId, output.runId);
    assert.deepEqual(state.plan, saved.plan);
    if (scenario === 'keep') {
      assert.equal(state.goal, saved.goal);
      assert.equal(state.adjustedGoal, saved.adjustedGoal);
    } else {
      assert.equal(state.goal, widened);
      assert.equal('adjustedGoal' in state, false, 'a new goal drops the old calibration');
      assert.equal(supervisorInputs[0]?.userRequest, widened);
    }
  });
}

test('Entry Answer preserves the current textual HumanMessage exactly', async () => {
  const scripted = entryAnswerModel('plan');
  let plannerRequest = '';
  const graph = createOrchestratorGraph({
    models: { act: scripted.model, answer: scripted.model },
    runSupervisorRunner: {
      async invoke(input) {
        plannerRequest = input.userRequest;
        return {
          reply: '当前没有可用的 Capability。',
        };
      },
    },
  });
  const request = '  读取仓库。\n\n保留这个排版。  ';

  const result = await graph.invoke(
    buildOrchestratorRunInput([new HumanMessage(request)]),
    invokeConfig(),
  );

  assert.equal(result.runUserRequest, request);
  assert.equal(plannerRequest, request);
});

test('Entry Answer resolves a continuation utterance into the goal it refers back to', async () => {
  const resolvedGoal = '把 docs/ 下的接口文档同步到最新实现。';
  const scripted = entryAnswerModel('plan', undefined, resolvedGoal);
  let plannerRequest = '';
  const graph = createOrchestratorGraph({
    models: { act: scripted.model, answer: scripted.model },
    runSupervisorRunner: {
      async invoke(input) {
        plannerRequest = input.userRequest;
        return {
          reply: '当前没有可用的 Capability。',
        };
      },
    },
  });

  const result = await graph.invoke(
    buildOrchestratorRunInput([
      new HumanMessage('帮我把 docs/ 下的接口文档同步到最新实现，先别动测试。'),
      new AIMessage('好的，我先确认一下范围：只更新 docs/ 下的接口文档，不改测试，对吗？'),
      new HumanMessage('嗯。开始吧'),
    ]),
    invokeConfig(),
  );

  // The continuation utterance never becomes the run goal: everything
  // downstream needs a request that stands on its own.
  assert.equal(result.runUserRequest, resolvedGoal);
  assert.equal(plannerRequest, resolvedGoal);
});

test('Entry Answer receives normalized main conversation and excludes delegation lanes', async () => {
  let entryMessages: BaseMessage[] = [];
  const scripted = entryAnswerModel('direct', (messages) => {
    entryMessages = messages;
  });
  const graph = createOrchestratorGraph({
    models: { act: scripted.model, answer: scripted.model },
    runSupervisorRunner: {
      async invoke() {
        throw new Error('Supervisor must not run for a direct reply.');
      },
    },
  });
  const compaction = createContextCompactionMessage('更早的主对话摘要。', 4);
  const laneMessage = new AIMessage('不应进入 Entry Answer 的 delegation lane。');
  setAgentMessageMetadata(laneMessage, {
    lane: 'capability:general',
    runId: 'older-run',
    delegationId: 'older-delegation',
  });
  const currentRequest = '这个方案还有更好的选择吗？';

  await graph.invoke(buildOrchestratorRunInput([
    compaction,
    new HumanMessage('之前我们在讨论 Entry 架构。'),
    new AIMessage('可以将 Answer 放在 Supervisor 之前。'),
    laneMessage,
    new HumanMessage(currentRequest),
  ]), invokeConfig());

  assert.deepEqual(readSnapshot(entryMessages[1].text), { origin: 'none', goal: null, plan: [] });
  assert.deepEqual(entryMessages.slice(2).map((message) => message.content), [
    compaction.content,
    '之前我们在讨论 Entry 架构。',
    '可以将 Answer 放在 Supervisor 之前。',
    currentRequest,
  ]);
  assert.equal(entryMessages.includes(laneMessage), false);
});

test('Entry Answer receives an accepted delegation result as execution data, not ordinary assistant prose', async () => {
  let entryMessages: BaseMessage[] = [];
  const scripted = entryAnswerModel('direct', (messages) => {
    entryMessages = messages;
  });
  const graph = createOrchestratorGraph({
    models: { act: scripted.model, answer: scripted.model },
    runSupervisorRunner: {
      async invoke() {
        throw new Error('Supervisor must not run for a direct reply.');
      },
    },
  });
  const announce = createDeliveryResult({
    id: 'delegation-announce:run-1:delegation-1:announce-1',
    sourceLane: 'capability:general',
    delegationId: 'delegation-1',
    runId: 'run-1',
    deliveryId: 'announce-1',
    task: '检查仓库状态',
    result: 'EXECUTED_RESULT_MARKER',
    createdAt: '2026-08-23T00:00:00.000Z',
  });

  await graph.invoke(buildOrchestratorRunInput([
    new HumanMessage('帮我检查仓库状态。'),
    ...withDeliveryCalls([announce]),
    new HumanMessage('把刚才的执行结果再说明一下。'),
  ]), invokeConfig());

  const projected = entryMessages.find((message) => message.id === announce.id);
  assert.ok(projected);
  assert.equal(projected._getType(), 'tool');
  assert.equal(projected.content, announce.content);
  assert.equal(JSON.parse(projected.text).delivery.text, 'EXECUTED_RESULT_MARKER');

});

function routingScript(turns: AIMessage[], entryAnswerToolOptions?: Record<string, unknown>) {
  const seen: BaseMessage[][] = [];
  const bindOptions: unknown[] = [];
  const model = {
    bindTools: (_tools: unknown, options?: unknown) => (bindOptions.push(options), {
      invoke: async (messages: BaseMessage[]) => {
        seen.push(messages);
        const next = turns[seen.length - 1];
        if (!next) throw new Error('Unexpected Entry turn.');
        return next;
      },
    }),
    invoke: async () => new AIMessage('当前没有可用的 Capability。'),
  } as unknown as BaseChatModel;
  const requests: string[] = [];
  const graph = createOrchestratorGraph({
    models: { act: model, answer: model },
    entryAnswerToolOptions,
    runSupervisorRunner: { async invoke(input) { requests.push(input.userRequest); return { reply: 'done' }; } },
  });
  return { graph, seen, requests, bindOptions };
}

test('Entry routing asks the provider for a single routing call when invoked', async () => {
  const { graph, bindOptions } = routingScript([new AIMessage(randomUUID())]);
  await graph.invoke(buildOrchestratorRunInput([new HumanMessage(randomUUID())]), invokeConfig());
  assert.deepEqual(bindOptions, [{ parallel_tool_calls: false }]);
});

test('Entry routing forwards host-selected tool binding options in both context modes', async () => {
  const options = { tool_choice: { type: 'auto', disable_parallel_tool_use: true } };
  const { graph, bindOptions } = routingScript([new AIMessage(randomUUID()), new AIMessage(randomUUID())], options);
  for (const hasExternalContext of [false, true]) await graph.invoke(
    buildOrchestratorRunInput([new HumanMessage(randomUUID())]), {
      ...invokeConfig(),
      ...(hasExternalContext ? { context: { workdir: null, systemPromptSections: [{ id: randomUUID(), content: randomUUID() }] } } : {}),
    },
  );
  assert.deepEqual(bindOptions, [options]);
});

test('Entry hands off once when a streamed turn also carries its call as a content block', async () => {
  // Streamed turns (streamEvents v3) keep the provider's call as a `tool_call`
  // content block; rewriting only tool_calls used to leave both IDs on the
  // message, so the handoff saw two calls and Entry looped on its own error.
  const call = { id: 'call-A', name: PLAN_REQUEST_TOOL_NAME, args: { goal: '截图所有页面' } };
  const { graph, seen, requests } = routingScript([new AIMessage({
    content: [{ type: 'reasoning', reasoning: 'think' }, { type: 'tool_call', ...call }],
    tool_calls: [call],
    additional_kwargs: { tool_calls: [{ id: 'call-A', type: 'function', function: { name: PLAN_REQUEST_TOOL_NAME, arguments: '{}' } }] },
    response_metadata: { output_version: 'v1' },
  })]);
  const output = await graph.invoke(buildOrchestratorRunInput([new HumanMessage('其他截图也截下来')]), invokeConfig());
  assert.equal(seen.length, 1);
  assert.deepEqual(requests, ['截图所有页面']);
  const routed = output.messages.find((message) => AIMessage.isInstance(message) && message.tool_calls?.length) as AIMessage;
  assert.equal(routed.tool_calls?.length, 1);
  assert.ok(routed.content.length && Array.isArray(routed.content));
  assert.deepEqual((routed.content as Array<{ type: string }>).map((block) => block.type).filter((type) => type !== 'tool_call'), ['reasoning']);
});

test('Entry routing accepts a tool call whose provider omitted the id', async () => {
  const { graph, seen, requests } = routingScript([new AIMessage({
    content: '', tool_calls: [{ id: undefined, name: PLAN_REQUEST_TOOL_NAME, args: { goal: '截图所有页面' } }],
  })]);
  await graph.invoke(buildOrchestratorRunInput([new HumanMessage('其他截图也截下来')]), invokeConfig());
  assert.equal(seen.length, 1);
  assert.deepEqual(requests, ['截图所有页面']);
});

test('Entry routing collapses a repeated identical call into one handoff', async () => {
  const call = { name: PLAN_REQUEST_TOOL_NAME, args: { goal: '截图所有页面' } };
  const { graph, seen, requests } = routingScript([new AIMessage({
    content: [{ type: 'text', text: 'routing' }, ...['a', 'b'].map(id => ({ type: 'tool_use' as const, id, name: call.name, input: call.args }))], tool_calls: [{ ...call, id: 'a' }, { ...call, id: 'b' }],
  })]);
  const output = await graph.invoke(buildOrchestratorRunInput([new HumanMessage('其他截图也截下来')]), invokeConfig());
  assert.equal(seen.length, 1);
  assert.deepEqual(requests, ['截图所有页面']);
  const routed = output.messages.filter((message) => AIMessage.isInstance(message) && message.tool_calls?.length);
  assert.equal(routed.length, 1);
  assert.equal((routed[0] as AIMessage).tool_calls?.length, 1);
  const content = (routed[0] as AIMessage).content as Array<{ type: string; id?: string }>;
  assert.deepEqual(content.filter(block => block.type === 'tool_use').map(block => block.id), ['a']);
  assert.equal(content[0].type, 'text');
});

test('Entry routing fails on distinct calls without a repair turn', async () => {
  const call = { name: PLAN_REQUEST_TOOL_NAME, args: { goal: '截图所有页面' } };
  for (const tool_calls of [
    [{ ...call, id: 'a' }, { ...call, id: 'b', args: { goal: '只截首页' } }],
    [{ id: 'a', name: 'continue', args: {} }, { ...call, id: 'b' }],
  ]) {
    const { graph, seen, requests } = routingScript([new AIMessage({ content: '', tool_calls })]);
    await assert.rejects(
      graph.invoke(buildOrchestratorRunInput([new HumanMessage('其他截图也截下来')]), invokeConfig()),
      /requires one tool call, got 2 distinct/,
    );
    assert.equal(seen.length, 1);
    assert.deepEqual(requests, []);
  }
});

test('Entry Answer fails on an empty reply instead of inventing one', async () => {
  const { graph, seen } = routingScript([new AIMessage({ content: ' ' })]);
  await assert.rejects(
    graph.invoke(buildOrchestratorRunInput([new HumanMessage('其他截图也截下来')]), invokeConfig()),
    /must reply or request routing/,
  );
  assert.equal(seen.length, 1);
});

test('Entry Answer leaves an ordinary reply untouched', async () => {
  const scripted = entryAnswerModel('direct');
  const graph = createOrchestratorGraph({
    models: { act: scripted.model, answer: scripted.model },
    runSupervisorRunner: {
      async invoke() {
        throw new Error('Supervisor must not run for a direct reply.');
      },
    },
  });

  await graph.invoke(
    buildOrchestratorRunInput([new HumanMessage('这个方案还有更好的选择吗？')]),
    invokeConfig(),
  );

  assert.deepEqual(scripted.counts(), { boundCalls: 1, resultCalls: 0 });
});

test('root invocation context reaches direct Entry replies and final Answer without node plumbing', async () => {
  for (const mode of ['direct', 'plan'] as const) {
    const seen: BaseMessage[][] = [];
    const scripted = entryAnswerModel(mode, messages => seen.push(messages), undefined, messages => seen.push(messages));
    const graph = createOrchestratorGraph({
      models: { act: scripted.model, answer: scripted.model },
      runSupervisorRunner: { async invoke() { return { reply: 'Unavailable.' }; } },
    });
    const common = [{ id: 'host:pet', content: randomUUID() }, { id: 'host:extra', content: randomUUID() }];
    await runAgent(graph, {
      messages: [new HumanMessage('Handle this request.')], context: { systemPromptSections: common },
    });
    assert.equal(seen.length, 1);
    for (const messages of seen) {
      for (const section of common) assert.equal(messages[0].text.split(section.content).length - 1, 1);
    }
    seen.length = 0;
    await runAgent(graph, { messages: [new HumanMessage('No common context this time.')] });
    for (const messages of seen) {
      for (const section of common) assert.equal(messages[0].text.includes(section.content), false);
    }
  }
});

test('Entry routing goals retain validation and optional continuation semantics', () => {
  const goal = randomUUID();
  for (const makeTool of [createPlanRequestTool, createContinueTool]) {
    const routingTool = makeTool();
    assert.deepEqual(Object.keys(routingTool.schema.shape), ['goal']);
    assert.deepEqual(routingTool.schema.parse({ goal: `  ${goal}\n` }), { goal });
    assert.equal(routingTool.schema.safeParse({}).success, routingTool.name === 'continue');
    for (const input of [{ goal: '' }, { goal: ' \n ' },
      { goal: 7 }, { goal: null }, { goal, unexpected: true }, { goal: goal.repeat(100) }]) {
      assert.equal(routingTool.schema.safeParse(input).success, false);
    }
  }
});

test('external system sections select role-aware Entry input while sharing the same tools', async t => {
  const workdir = `/tmp/${randomUUID()}`;
  const section = (id: string) => ({ id, content: randomUUID() });
  const cases: Array<{ name: string; context?: AgentRuntimeContext; scoped: boolean }> = [
    { name: 'no context', scoped: false },
    { name: 'empty context', context: {}, scoped: false },
    { name: 'empty sections', context: { systemPromptSections: [] }, scoped: false },
    { name: 'workdir only', context: { workdir }, scoped: false },
    { name: 'workdir with empty sections', context: { workdir, systemPromptSections: [] }, scoped: false },
    { name: 'anonymous caller section', context: { systemPromptSections: [section(randomUUID())] }, scoped: true },
    { name: 'PET only', context: { systemPromptSections: [section('pet:document')] }, scoped: true },
    { name: 'Channel only', context: { systemPromptSections: [section('channel:context')] }, scoped: true },
  ];
  for (const scenario of cases) await t.test(scenario.name, async () => {
    const capability = entryCapability();
    const request = randomUUID();
    const goal = randomUUID();
    const observed = observeEntryBindings(() => new AIMessage({ content: '', tool_calls: [{
      id: randomUUID(), name: PLAN_REQUEST_TOOL_NAME, args: { goal: `  ${goal}\n` },
    }] }));
    const supervisorInputs: RunSupervisorInput[] = [];
    const graph = createOrchestratorGraph({
      models: { act: observed.model, answer: observed.model }, defaultCapabilityName: capability.name,
      runSupervisorRunner: { async invoke(input) { supervisorInputs.push(input); return { reply: randomUUID() }; } },
    });
    const result = await runAgent(graph, {
      messages: [new HumanMessage(request)], capabilities: [capability], context: scenario.context,
    });
    assert.equal(observed.invocations.length, 1);
    const { messages, tools, options } = observed.invocations[0];
    assert.deepEqual(options, { parallel_tool_calls: false });
    assert.deepEqual(entryToolDescriptions(tools), entryToolDescriptions([
      createPlanRequestTool(), createContinueTool(),
    ]));
    const systems = messages.filter(message => message._getType() === 'system');
    assert.equal(systems.length, 1);
    const system = systems[0].text;
    if (scenario.scoped) {
      assert.ok(system.startsWith(buildEntryAnswerSystemPrompt(true)));
      assert.deepEqual(readCapabilityManifest(system), {
        defaultCapabilityName: capability.name,
        capabilities: [{ name: capability.name, purpose: capability.description, toolkits: [] }],
      });
    } else {
      assert.equal(system, composeSystemPrompt(new SystemMessage(buildEntryAnswerSystemPrompt(false)), scenario.context).text);
      for (const hidden of [capability.name, capability.description]) assert.equal(system.includes(hidden), false);
    }
    for (const injected of scenario.context?.systemPromptSections ?? []) {
      assert.equal(system.split(injected.content).length - 1, 1);
    }
    assert.equal(system.includes(capability.instructions.content), false);
    assert.equal(supervisorInputs.length, 1);
    assert.equal(supervisorInputs[0].userRequest, goal);
    assert.equal(supervisorInputs[0].mode, 'entry');
    assert.ok(supervisorInputs[0].messages.some(message => message.text === request));
    assert.ok(result.messages.some(message => ToolMessage.isInstance(message) && message.name === PLAN_REQUEST_TOOL_NAME));
    const privateFacts = [capability.description, ...(scenario.context?.systemPromptSections ?? []).map(item => item.content)];
    for (const history of [supervisorInputs[0].messages, result.messages]) {
      for (const hidden of privateFacts) assert.equal(history.some(message => message.text.includes(hidden)), false);
    }
  });
});

test('one Entry graph switches external context on, off and on without retaining summaries or changing tools', async () => {
  const capabilities = [entryCapability(), entryCapability(), entryCapability()];
  const firstSection = { id: randomUUID(), content: randomUUID() };
  const nextSection = { id: randomUUID(), content: randomUUID() };
  const contexts: Array<AgentRuntimeContext | undefined> = [
    { systemPromptSections: [firstSection] }, undefined, { systemPromptSections: [nextSection] },
  ];
  const observed = observeEntryBindings(() => new AIMessage(randomUUID()));
  const graph = createOrchestratorGraph({
    models: { act: observed.model, answer: observed.model },
    runSupervisorRunner: { async invoke() { throw new Error('Direct replies do not need Supervisor.'); } },
  });
  for (const [index, context] of contexts.entries()) {
    await runAgent(graph, { messages: [new HumanMessage(randomUUID())], context, capabilities: [capabilities[index]] });
    assert.equal(observed.invocations.length, index + 1);
    const { messages, tools } = observed.invocations[index];
    const system = messages[0].text;
    const scoped = index !== 1;
    assert.deepEqual(entryToolDescriptions(tools), entryToolDescriptions([
      createPlanRequestTool(), createContinueTool(),
    ]));
    if (scoped) {
      assert.deepEqual(readCapabilityManifest(system).capabilities, [{
        name: capabilities[index].name, purpose: capabilities[index].description, toolkits: [],
      }]);
    } else {
      assert.equal(system, buildEntryAnswerSystemPrompt(false));
    }
    for (const [otherIndex, capability] of capabilities.entries()) {
      assert.equal(system.includes(capability.description), scoped && otherIndex === index);
      assert.equal(system.includes(capability.instructions.content), false);
    }
    assert.equal(system.includes(firstSection.content), index === 0);
    assert.equal(system.includes(nextSection.content), index === 2);
  }
  assert.deepEqual(entryToolDescriptions(observed.invocations[0].tools), entryToolDescriptions(observed.invocations[1].tools));
  assert.deepEqual(entryToolDescriptions(observed.invocations[0].tools), entryToolDescriptions(observed.invocations[2].tools));
});

test('Entry receives identity and capability summaries before resolving the goal without persisting the summaries', async () => {
  const identity = randomUUID();
  const channel = randomUUID();
  const toolkitName = `toolkit_${randomUUID().replaceAll('-', '')}`;
  const toolkitDescription = randomUUID();
  const capability = { ...entryCapability(), uses: [toolkitName] };
  const request = randomUUID();
  const goal = randomUUID();
  const seen: BaseMessage[][] = [];
  const scripted = entryAnswerModel('plan', messages => seen.push(messages), goal);
  const supervisorInputs: RunSupervisorInput[] = [];
  const graph = createOrchestratorGraph({
    models: { act: scripted.model, answer: scripted.model },
    defaultCapabilityName: capability.name,
    runSupervisorRunner: { async invoke(input) { supervisorInputs.push(input); return { reply: 'Done.' }; } },
  });

  const result = await runAgent(graph, {
    messages: [new HumanMessage(request)],
    context: { systemPromptSections: [
      { id: 'pet:document', content: identity },
      { id: 'channel:context', content: channel },
    ] },
    capabilities: [capability],
    toolkits: [{
      name: toolkitName, description: toolkitDescription,
      tools: [{ tool: tool(() => 'unused', { name: 'read_probe', description: randomUUID(), schema: z.object({}) }) }],
    }],
  });

  assert.equal(seen.length, 1);
  const system = seen[0].filter(message => message._getType() === 'system').map(message => message.text).join('\n');
  for (const content of [identity, channel]) assert.equal(system.split(content).length - 1, 1);
  assert.deepEqual(readCapabilityManifest(system), {
    defaultCapabilityName: capability.name,
    capabilities: [{ name: capability.name, purpose: capability.description, toolkits: [{ name: toolkitName, description: toolkitDescription }] }],
  });
  assert.equal(seen[0].some(message => message.text.includes(capability.instructions.content)), false);
  assert.equal(supervisorInputs[0].userRequest, goal);
  assert.ok(supervisorInputs[0].messages.some(message => message.text === request));
  assert.ok(result.messages.some(message => message.text === request));
  for (const messages of [supervisorInputs[0].messages, result.messages]) {
    assert.equal(messages.some(message => message.text.includes(capability.description)), false);
    assert.equal(messages.some(message => message.text.includes(toolkitDescription)), false);
  }
});

test('Entry refreshes the capability summary and applies the current allowlist on every invocation', async () => {
  const first = entryCapability();
  const second = entryCapability();
  const seen: BaseMessage[][] = [];
  const scripted = entryAnswerModel('direct', messages => seen.push(messages));
  const graph = createOrchestratorGraph({
    models: { act: scripted.model, answer: scripted.model },
    defaultCapabilityName: second.name,
    runSupervisorRunner: { async invoke() { throw new Error('Direct replies do not need Supervisor.'); } },
  });
  const invoke = (capabilities: AgentCapability[], allowedCapabilityNames?: string[]) => runAgent(graph, {
    messages: [new HumanMessage(randomUUID())], capabilities, allowedCapabilityNames,
    context: { systemPromptSections: [{ id: randomUUID(), content: randomUUID() }] },
  });

  await invoke([first, second], [first.name]);
  const firstInput = seen[0].map(message => message.text).join('\n');
  assert.deepEqual(readCapabilityManifest(firstInput), {
    defaultCapabilityName: undefined,
    capabilities: [{ name: first.name, purpose: first.description, toolkits: [] }],
  });
  for (const hidden of [second.name, second.description, first.instructions.content, second.instructions.content]) {
    assert.equal(firstInput.includes(hidden), false);
  }

  const updated = { ...second, description: randomUUID() };
  await invoke([updated]);
  const secondInput = seen[1].map(message => message.text).join('\n');
  assert.deepEqual(readCapabilityManifest(secondInput), {
    defaultCapabilityName: updated.name,
    capabilities: [{ name: updated.name, purpose: updated.description, toolkits: [] }],
  });
  for (const stale of [first.name, first.description, second.description, updated.instructions.content]) {
    assert.equal(secondInput.includes(stale), false);
  }

  await invoke([first, second], []);
  const emptyInput = seen[2].map(message => message.text).join('\n');
  assert.deepEqual(readCapabilityManifest(emptyInput), { defaultCapabilityName: undefined, capabilities: [] });
  for (const hidden of [first.name, first.description, second.name, second.description]) {
    assert.equal(emptyInput.includes(hidden), false);
  }
});


for (const { status, hasExternalContext } of (['empty', 'completed', 'superseded'] as const)
  .flatMap(status => [false, true].map(hasExternalContext => ({ status, hasExternalContext })))) {
  test(`Entry exposes the ${status} plan and rejects continue without handing off with external context ${hasExternalContext}`, async () => {
    const plan = { runId: null, goal: status === 'empty' ? null : 'Plan the trip.', plan: status === 'empty' ? [] : [
      { id: 'trip', capability: 'general', objective: 'Plan the trip.', status },
    ] };
    let turns = 0;
    const model = { bindTools: (tools: Array<{ name: string }>) => {
      assert.deepEqual(tools.map(tool => tool.name), ['plan_request', 'continue']);
      return { invoke: async (messages: BaseMessage[]) => {
        assert.deepEqual(readSnapshot(messages[1].text), {
          origin: status === 'empty' ? 'none' : 'previous_run',
          goal: plan.goal,
          // Plan item ids are not projected; the model never cites them.
          plan: plan.plan.map(({ capability, status: itemStatus, objective }) =>
            ({ capability, status: itemStatus, objective })),
        });
        if (++turns === 1) return new AIMessage({ content: '', tool_calls: [{ name: 'continue', id: 'invalid-continue', args: {} }] });
        assert.ok(messages.some(message => ToolMessage.isInstance(message) && message.name === 'continue' && message.status === 'error'));
        return new AIMessage('请说明接下来要完成的目标。');
      } };
    } } as unknown as BaseChatModel;
    const graph = createOrchestratorGraph({ models: { act: model, answer: model }, runSupervisorRunner: {
      invoke: async () => { throw new Error('Invalid continue must not hand off to Supervisor.'); },
    } });
    const output = await graph.invoke({ ...buildOrchestratorRunInput([new HumanMessage('继续。')]), runSupervisorState: plan }, {
      ...invokeConfig(),
      ...(hasExternalContext ? { context: { workdir: null, systemPromptSections: [{ id: randomUUID(), content: randomUUID() }] } } : {}),
    });
    assert.equal(turns, 2);
    assert.deepEqual(output.runSupervisorState, plan);
    assert.equal(output.runIterationCount, 0);
  });
}

test('snapshot origin separates no plan from a run that owns one and a run that inherited it', () => {
  const plan = [{ id: 'task:hash', capability: 'general', objective: 'Inspect.', status: 'pending' as const }];
  const origin = (state: Parameters<typeof entryPlanMessage>[0]) =>
    readSnapshot(entryPlanMessage(state, 'r1').text).origin;

  // A fresh conversation has no earlier run to inherit from, so "none" is its
  // own answer rather than a previous run that happens to be empty.
  assert.equal(origin({ runId: null, goal: null, plan: [] }), 'none');
  assert.equal(origin({ runId: 'r1', goal: 'Inspect.', plan }), 'current_run');
  assert.equal(origin({ runId: 'r0', goal: 'Inspect.', plan }), 'previous_run');
  // Checkpoints written before runId existed carry a plan with no owning run.
  assert.equal(origin({ runId: null, goal: 'Inspect.', plan }), 'previous_run');

  // Plan item ids are content hashes the model never cites, so they stay out.
  assert.doesNotMatch(entryPlanMessage({ runId: 'r0', goal: 'Inspect.', plan }, 'r1').text, /task:hash/);
});
