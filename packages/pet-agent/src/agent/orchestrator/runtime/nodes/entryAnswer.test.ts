import test from 'node:test';
import assert from 'node:assert/strict';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { compileAgentRegistry } from '../../registry';
import type { CapabilityPlannerInput } from '../../capabilityPlanner/runner';
import { buildOrchestratorRunInput } from '../../state';
import type { OrchestratorConfig } from '../../types';
import { createOrchestratorGraph } from '../graph';
import { PLAN_REQUEST_TOOL_NAME } from './entryAnswer';
import { createContextCompactionMessage } from '../../contextCompaction';
import { setPinpetMeta } from '../../messageLanes';

function entryAnswerModel(
  mode: 'direct' | 'plan',
  onEntryInvoke?: (messages: BaseMessage[]) => void,
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
                args: {},
              }],
            })
          : new AIMessage('可以，现有信息足够直接回答。');
      },
    }),
    invoke: async () => {
      resultCalls += 1;
      return new AIMessage('当前没有可执行该任务的 Capability。');
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

const actor = {
  petId: 'pet-1',
  userId: 'user-1',
  name: '小白',
  personality: null,
  stage: null,
  species: null,
};

test('Entry Answer returns an ordinary reply without invoking Planner', async () => {
  const scripted = entryAnswerModel('direct');
  let plannerCalls = 0;
  const graph = createOrchestratorGraph({
    models: { act: scripted.model, answer: scripted.model },
    actor,
    capabilityPlannerRunner: {
      async invoke() {
        plannerCalls += 1;
        return { action: 'unavailable', tasks: [] };
      },
    },
  } as OrchestratorConfig);

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

test('plan_request routes to Planner without persisting control messages', async () => {
  const scripted = entryAnswerModel('plan');
  const plannerInputs: CapabilityPlannerInput[] = [];
  const graph = createOrchestratorGraph({
    models: { act: scripted.model, answer: scripted.model },
    actor,
    capabilityPlannerRunner: {
      async invoke(input) {
        plannerInputs.push(input);
        return { action: 'unavailable', tasks: [] };
      },
    },
  });
  const request = '读取仓库文件并检查当前实现。';

  const result = await graph.invoke(
    buildOrchestratorRunInput([new HumanMessage(request)]),
    invokeConfig(),
  );

  assert.deepEqual(scripted.counts(), { boundCalls: 1, resultCalls: 1 });
  assert.equal(plannerInputs[0]?.userRequest, request);
  assert.equal(plannerInputs[0]?.mainMessages?.at(-1)?.content, request);
  assert.equal(result.runUserRequest, request);
  assert.equal(result.messages.some((message) => ToolMessage.isInstance(message)), false);
  assert.equal(result.messages.some((message) => (
    AIMessage.isInstance(message)
    && message.tool_calls?.some((call) => call.name === PLAN_REQUEST_TOOL_NAME)
  )), false);
  assert.equal(result.messages.at(-1)?.content, '当前没有可执行该任务的 Capability。');
});

test('Entry Answer preserves the current textual HumanMessage exactly', async () => {
  const scripted = entryAnswerModel('plan');
  let plannerRequest = '';
  const graph = createOrchestratorGraph({
    models: { act: scripted.model, answer: scripted.model },
    actor,
    capabilityPlannerRunner: {
      async invoke(input) {
        plannerRequest = input.userRequest;
        return { action: 'unavailable', tasks: [] };
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

test('Entry Answer receives normalized main conversation and excludes delegation lanes', async () => {
  let entryMessages: BaseMessage[] = [];
  const scripted = entryAnswerModel('direct', (messages) => {
    entryMessages = messages;
  });
  const graph = createOrchestratorGraph({
    models: { act: scripted.model, answer: scripted.model },
    actor,
    capabilityPlannerRunner: {
      async invoke() {
        throw new Error('Planner must not run for a direct reply.');
      },
    },
  });
  const compaction = createContextCompactionMessage('更早的主对话摘要。', 4);
  const laneMessage = new AIMessage('不应进入 Entry Answer 的 delegation lane。');
  setPinpetMeta(laneMessage, {
    lane: 'capability:general',
    runId: 'older-run',
    delegationId: 'older-delegation',
  });
  const currentRequest = '这个方案还有更好的选择吗？';

  await graph.invoke(buildOrchestratorRunInput([
    compaction,
    new HumanMessage('之前我们在讨论 Entry 架构。'),
    new AIMessage('可以将 Answer 放在 Planner 之前。'),
    laneMessage,
    new HumanMessage(currentRequest),
  ]), invokeConfig());

  assert.deepEqual(entryMessages.slice(1).map((message) => message.content), [
    compaction.content,
    '之前我们在讨论 Entry 架构。',
    '可以将 Answer 放在 Planner 之前。',
    currentRequest,
  ]);
  assert.equal(entryMessages.includes(laneMessage), false);
});
