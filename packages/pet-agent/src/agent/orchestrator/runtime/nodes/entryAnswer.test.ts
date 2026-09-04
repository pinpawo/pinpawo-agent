import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { runAgent } from '../../../runAgent';
import assert from 'node:assert/strict';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { compileAgentRegistry } from '../../registry';
import type { RunSupervisorInput } from '../../runSupervisor/runner';
import { buildOrchestratorRunInput } from '../../state';
import type { OrchestratorStateType } from '../../state';
import type { OrchestratorConfig } from '../../types';
import { createOrchestratorGraph } from '../graph';
import { captureRunUserRequest, PLAN_REQUEST_TOOL_NAME } from './entryAnswer';
import { createContextCompactionMessage } from '../../contextCompaction';
import {
  mainConversationMessages,
  setAgentMessageMetadata,
} from '../../../messages';
import { DelegationAnnounceMessage } from '../../delegation';

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

test('entry capture clears any stale Supervisor session', () => {
  const input = {
    ...buildOrchestratorRunInput(
      [new HumanMessage('开始一个新的任务。')],
      { activeDelegationTransition: 'resume_active', traceId: 'new-trace' },
    ),
    taskActiveDelegation: null,
    runSupervisorSession: {} as never,
  } as unknown as OrchestratorStateType;
  const update = captureRunUserRequest(input);

  assert.equal(update.runSupervisorSession, null);
  assert.equal(update.taskRunContinuation, null);
});

test('entry capture does not retain a prior active delegation Supervisor session', () => {
  const input = {
    ...buildOrchestratorRunInput(
      [new HumanMessage('继续。')],
      { activeDelegationTransition: 'resume_active', traceId: 'active-trace' },
    ),
    taskActiveDelegation: {
      id: 'active-delegation',
      lane: 'capability:general',
      task: '继续当前任务。',
      contextSummary: null,
      runId: 'previous-run',
      traceId: 'active-trace',
      status: 'awaiting_decision',
      resultPreview: null,
      userRequest: '完成当前任务。',
    },
    runSupervisorSession: {} as never,
  } as unknown as OrchestratorStateType;
  const update = captureRunUserRequest(input);

  assert.equal(update.runSupervisorSession, null);
});

test('Entry Answer returns an ordinary reply without invoking Supervisor', async () => {
  const scripted = entryAnswerModel('direct');
  let plannerCalls = 0;
  const graph = createOrchestratorGraph({
    models: { act: scripted.model, answer: scripted.model },
    actor,
    runSupervisorRunner: {
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

test('plan_request routes to Supervisor without persisting control messages', async () => {
  const scripted = entryAnswerModel('plan');
  const supervisorInputs: RunSupervisorInput[] = [];
  const graph = createOrchestratorGraph({
    models: { act: scripted.model, answer: scripted.model },
    actor,
    runSupervisorRunner: {
      async invoke(input) {
        supervisorInputs.push(input);
        return {
          action: 'unavailable',
          tasks: [],
        };
      },
    },
  });
  const request = '读取仓库文件并检查当前实现。';

  const result = await graph.invoke(
    buildOrchestratorRunInput([new HumanMessage(request)]),
    invokeConfig(),
  );

  assert.deepEqual(scripted.counts(), { boundCalls: 1, resultCalls: 1 });
  assert.equal(supervisorInputs[0]?.userRequest, request);
  assert.equal(supervisorInputs[0]?.messages.some((message) => message.content === request), true);
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
    runSupervisorRunner: {
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

test('Entry Answer resolves a continuation utterance into the goal it refers back to', async () => {
  const resolvedGoal = '把 docs/ 下的接口文档同步到最新实现。';
  const scripted = entryAnswerModel('plan', undefined, resolvedGoal);
  let plannerRequest = '';
  const graph = createOrchestratorGraph({
    models: { act: scripted.model, answer: scripted.model },
    actor,
    runSupervisorRunner: {
      async invoke(input) {
        plannerRequest = input.userRequest;
        return { action: 'unavailable', tasks: [] };
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
    actor,
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

  assert.deepEqual(entryMessages.slice(1).map((message) => message.content), [
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
    actor,
    runSupervisorRunner: {
      async invoke() {
        throw new Error('Supervisor must not run for a direct reply.');
      },
    },
  });
  const announce = new DelegationAnnounceMessage({
    id: 'delegation-announce:run-1:delegation-1:announce-1',
    sourceLane: 'capability:general',
    delegationId: 'delegation-1',
    runId: 'run-1',
    announceMessageId: 'announce-1',
    task: '检查仓库状态',
    completionReason: 'natural',
    result: 'EXECUTED_RESULT_MARKER',
    createdAt: '2026-08-23T00:00:00.000Z',
  });

  await graph.invoke(buildOrchestratorRunInput([
    new HumanMessage('帮我检查仓库状态。'),
    announce,
    new HumanMessage('把刚才的执行结果再说明一下。'),
  ]), invokeConfig());

  const projected = entryMessages.find((message) => message.id === announce.id);
  assert.ok(projected);
  assert.notEqual(projected, announce);
  assert.notEqual(projected.content, announce.content);
  assert.equal(projected._getType(), 'ai');
  assert.doesNotMatch(String(projected.content), /<artifacts>/);
});

test('Entry Answer retries when the model announces execution instead of calling plan_request', async () => {
  const goal = 'review https://github.com/pinpawo/pinpawo-agent/pull/667';
  let invocations = 0;
  let repairPrompt = '';
  const model = {
    bindTools: () => ({
      invoke: async (messages: BaseMessage[]) => {
        invocations += 1;
        if (invocations === 1) {
          return new AIMessage('开始执行计划任务：对 Pull Request #667 进行代码审查。');
        }
        repairPrompt = String(messages.at(-1)?.content ?? '');
        return new AIMessage({
          content: '',
          tool_calls: [{ id: 'call-plan', name: PLAN_REQUEST_TOOL_NAME, args: { goal } }],
        });
      },
    }),
    invoke: async () => new AIMessage('当前没有可执行该任务的 Capability。'),
  } as unknown as BaseChatModel;

  let plannerRequest = '';
  const graph = createOrchestratorGraph({
    models: { act: model, answer: model },
    actor,
    runSupervisorRunner: {
      async invoke(input) {
        plannerRequest = input.userRequest;
        return { action: 'unavailable', tasks: [] };
      },
    },
  });

  const result = await graph.invoke(
    buildOrchestratorRunInput([new HumanMessage('你自己review一下这个pr')]),
    invokeConfig(),
  );

  assert.equal(invocations, 2, 'the faked announcement must trigger exactly one retry');
  assert.match(repairPrompt, /plan_request/);
  assert.equal(plannerRequest, goal, 'the retry must reach the Supervisor');
  assert.equal(
    result.messages.some((message) => String(message.content).startsWith('开始执行计划任务')),
    false,
    'the faked announcement must never reach the user',
  );
});

test('Entry Answer leaves an ordinary reply untouched', async () => {
  const scripted = entryAnswerModel('direct');
  const graph = createOrchestratorGraph({
    models: { act: scripted.model, answer: scripted.model },
    actor,
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
      models: { act: scripted.model, answer: scripted.model }, actor,
      runSupervisorRunner: { async invoke() { return { action: 'unavailable', tasks: [] }; } },
    });
    const common = [{ id: 'host:pet', content: randomUUID() }, { id: 'host:extra', content: randomUUID() }];
    await runAgent(graph, {
      messages: [new HumanMessage('Handle this request.')], context: { systemPromptSections: common },
    });
    assert.equal(seen.length, mode === 'plan' ? 2 : 1);
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
