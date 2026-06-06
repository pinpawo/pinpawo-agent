import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AIMessage } from '@langchain/core/messages';
import { isCommand } from '@langchain/langgraph';

import { createPetAgentRuntime } from './createPetAgentRuntime';
import {
  buildHumanReviewRequest,
  type HumanReviewDecision,
  type HumanReviewRequest,
} from '../orchestrator/humanReview';
import type { OrchestratorGraph } from '../createAgentRuntime';
import type { AgentActor, AgentModels } from '../../types/agent';

function fakeModels(): AgentModels {
  // graph 已被 stub,实际不会用到 models。
  return {} as AgentModels;
}

function fakeActor(): AgentActor {
  return {
    petId: 'p1',
    userId: 'u1',
    name: 'Test Pet',
    personality: null,
    stage: null,
    species: null,
  };
}

function makeStubGraph(responses: unknown[]): {
  graph: OrchestratorGraph;
  calls: { input: unknown; options?: unknown }[];
} {
  const calls: { input: unknown; options?: unknown }[] = [];
  let i = 0;
  const graph = {
    invoke: async (input: unknown, options?: unknown) => {
      calls.push({ input, options });
      const r = responses[i++];
      if (r === undefined) {
        throw new Error(`graph stub exhausted at call #${i}`);
      }
      return r;
    },
  } as unknown as OrchestratorGraph;
  return { graph, calls };
}

const sampleReview: HumanReviewRequest = buildHumanReviewRequest({
  actionRequests: [{ name: 'do_x', args: { foo: 1 }, description: 'do x' }],
  reviewConfigs: [{ actionName: 'do_x', allowedDecisions: ['approve', 'reject', 'respond'] }],
  prompt: 'Approve do_x?',
});

test('humanReviewer: single interrupt → approve → reply', async () => {
  const requests: HumanReviewRequest[] = [];
  const { graph } = makeStubGraph([
    { __interrupt__: [{ value: sampleReview }], messages: [] },
    { messages: [new AIMessage('all done')] },
  ]);

  const runtime = createPetAgentRuntime({
    models: fakeModels(),
    actor: fakeActor(),
    graph,
    humanReviewer: async (req) => {
      requests.push(req);
      return { type: 'approve' };
    },
  });

  const result = await runtime.invoke({ brief: 'go' });
  assert.equal(result.reply, 'all done');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].prompt, 'Approve do_x?');
});

test('humanReviewer: multi-round interrupt loops until resolved', async () => {
  const requests: HumanReviewRequest[] = [];
  const { graph } = makeStubGraph([
    { __interrupt__: [{ value: sampleReview }], messages: [] },
    { __interrupt__: [{ value: sampleReview }], messages: [] },
    { messages: [new AIMessage('done after two reviews')] },
  ]);

  const runtime = createPetAgentRuntime({
    models: fakeModels(),
    actor: fakeActor(),
    graph,
    humanReviewer: async (req) => {
      requests.push(req);
      return { type: 'approve' };
    },
  });

  const result = await runtime.invoke({ brief: 'go' });
  assert.equal(result.reply, 'done after two reviews');
  assert.equal(requests.length, 2);
});

test('humanReviewer: missing reviewer + interrupt → invoke throws', async () => {
  const { graph } = makeStubGraph([
    { __interrupt__: [{ value: sampleReview }], messages: [] },
  ]);

  const runtime = createPetAgentRuntime({
    models: fakeModels(),
    actor: fakeActor(),
    graph,
  });

  await assert.rejects(
    () => runtime.invoke({ brief: 'go' }),
    /no humanReviewer configured/,
  );
});

test('humanReviewer: resume call passes Command with decision', async () => {
  const { graph, calls } = makeStubGraph([
    { __interrupt__: [{ value: sampleReview }], messages: [] },
    { messages: [new AIMessage('rejected')] },
  ]);

  const runtime = createPetAgentRuntime({
    models: fakeModels(),
    actor: fakeActor(),
    graph,
    humanReviewer: async () => ({ type: 'reject', message: 'not now' }),
  });

  await runtime.invoke({ brief: 'go' });

  assert.equal(calls.length, 2);
  // 第一次调用应为初始 turn input(普通 object,带 messages);Command 实例的是第二次。
  assert.equal(isCommand(calls[0].input), false);
  assert.equal(isCommand(calls[1].input), true);
  const resume = (calls[1].input as { resume: { decisions: HumanReviewDecision[] } }).resume;
  assert.equal(resume.decisions[0]?.type, 'reject');
  assert.equal(
    (resume.decisions[0] as Extract<HumanReviewDecision, { type: 'reject' }>).message,
    'not now',
  );
});

test('humanReviewer: non-human_review interrupt is not treated as HITL', async () => {
  // 假设 graph 抛出某种非 human_review 类型的 interrupt;pet runtime 应直接返回(reply 空),
  // 不调用 humanReviewer。
  let reviewerCalled = false;
  const { graph } = makeStubGraph([
    { __interrupt__: [{ value: { kind: 'other_kind' } }], messages: [] },
  ]);

  const runtime = createPetAgentRuntime({
    models: fakeModels(),
    actor: fakeActor(),
    graph,
    humanReviewer: async () => {
      reviewerCalled = true;
      return { type: 'approve' };
    },
  });

  const result = await runtime.invoke({ brief: 'go' });
  assert.equal(reviewerCalled, false);
  assert.equal(result.reply, '');
});

test('pet runtime passes wiki read tools and operation metadata when wikiRoot is provided', async () => {
  const { graph, calls } = makeStubGraph([
    { messages: [new AIMessage('done')] },
  ]);

  const runtime = createPetAgentRuntime({
    models: fakeModels(),
    actor: fakeActor(),
    graph,
    toolkits: [{
      name: 'plugin_toolkit',
      description: 'plugin toolkit',
      operations: {
        plugin_tool: {
          title: 'Plugin Tool',
        },
      },
    }],
  });

  const result = await runtime.invoke({
    brief: 'read wiki',
    wikiRoot: '/tmp/pinpawo-test-wiki',
    toolkits: [{
      name: 'invoke_toolkit',
      description: 'invoke toolkit',
      operations: {
        invoke_tool: {
          title: 'Invoke Tool',
        },
      },
    }],
  });

  assert.equal(result.reply, 'done');
  const configurable = (calls[0]?.options as {
    configurable?: {
      toolkits?: Array<{ name?: string; operations?: Record<string, { title?: string }> }>;
    };
  } | undefined)?.configurable;
  assert.ok(configurable, 'graph should receive configurable');
  const wikiToolkit = configurable.toolkits?.find((toolkit) => toolkit.name === 'wiki_read');
  const pluginToolkit = configurable.toolkits?.find((toolkit) => toolkit.name === 'plugin_toolkit');
  const invokeToolkit = configurable.toolkits?.find((toolkit) => toolkit.name === 'invoke_toolkit');
  assert.ok(pluginToolkit, 'config toolkits should be forwarded to runtime invoke');
  assert.equal(pluginToolkit.operations?.plugin_tool?.title, 'Plugin Tool');
  assert.ok(invokeToolkit, 'invoke toolkits should be forwarded to runtime invoke');
  assert.equal(invokeToolkit.operations?.invoke_tool?.title, 'Invoke Tool');
  assert.ok(wikiToolkit, 'wikiRoot should install wiki_read as a toolkit');
  assert.equal(wikiToolkit.operations?.wiki_read_cat?.title, '读取知识库文件');
  assert.equal(wikiToolkit.operations?.wiki_read_grep?.title, '搜索知识库内容');
});
