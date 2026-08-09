import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AIMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { isCommand } from '@langchain/langgraph';
import { z } from 'zod';

import { createPetAgentRuntime } from './createPetAgentRuntime';
import type { OrchestratorGraph } from '@pinpawo/pet-agent';
import { ToolkitRuntimeManager } from '@pinpawo/pet-agent';
import type { AgentActor, AgentModels } from '@pinpawo/pet-agent';
import { defineInstructionDocument } from '@pinpawo/pet-agent';
import type { NamedStructuredTool } from '@pinpawo/pet-agent';
import type { HumanReviewerRequest } from '@pinpawo/studio';

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

function mockTool<const TName extends string>(name: TName): NamedStructuredTool<TName> {
  return tool(async () => 'ok', {
    name,
    description: `${name} test tool`,
    schema: z.object({}),
  }) as NamedStructuredTool<TName>;
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

const sampleReviewInterrupt = {
  kind: 'review' as const,
  review: {
    id: 'review-direct',
    schemaVersion: 1,
    view: { kind: 'plain' as const, body: 'Approve do_y?' },
    options: [{
      id: 'approve',
      label: 'Approve',
      decision: { type: 'approve' as const },
    }],
  },
  pendingAction: {
    actionId: 'call-1',
    toolName: 'do_y',
    args: { foo: 2 },
  },
};

test('descriptor derives Capability status from registry compilation', () => {
  const runtime = createPetAgentRuntime({
    models: fakeModels(),
    actor: fakeActor(),
    capabilities: [{
      name: 'inspect',
      description: 'Inspect a repository.',
      uses: ['git'],
      instructions: defineInstructionDocument({
        content: '# Inspect',
      }),
    }],
    graph: makeStubGraph([]).graph,
  });

  assert.deepEqual(runtime.descriptor().capabilities, [{
    name: 'inspect',
    description: 'Inspect a repository.',
    available: false,
    reason: 'unknown Toolkit "git"',
  }]);
});

test('invoke evaluates Toolkit availability before compiling its registry generation', async () => {
  let availabilityChecks = 0;
  const { graph, calls } = makeStubGraph([
    { messages: [new AIMessage('done')] },
  ]);
  const runtime = createPetAgentRuntime({
    models: fakeModels(),
    actor: fakeActor(),
    capabilities: [{
      name: 'inspect',
      description: 'Inspect a repository.',
      uses: ['offline'],
      instructions: defineInstructionDocument({
        content: '# Inspect',
      }),
    }],
    toolkits: [{
      name: 'offline',
      description: 'Unavailable Toolkit.',
      tools: [{ tool: mockTool('offline_tool') }],
      availability: () => {
        availabilityChecks += 1;
        return { available: false, reason: 'offline' };
      },
    }],
    graph,
  });

  // Synchronous descriptors report static dependency resolution only.
  assert.equal(runtime.descriptor().capabilities[0]?.available, true);

  await runtime.invoke({ brief: 'inspect' });

  const registry = (calls[0]?.options as {
    configurable?: {
      registry?: {
        capabilities?: Array<{ capability: { name: string } }>;
        unavailableCapabilities?: Array<{
          capability: { name: string };
          issues: Array<{ code: string; toolkitName?: string }>;
        }>;
      };
    };
  } | undefined)?.configurable?.registry;
  assert.equal(availabilityChecks, 1);
  assert.deepEqual(registry?.capabilities, []);
  assert.equal(
    registry?.unavailableCapabilities?.[0]?.capability.name,
    'inspect',
  );
  assert.deepEqual(
    registry?.unavailableCapabilities?.[0]?.issues,
    [{ code: 'unknown_toolkit', toolkitName: 'offline' }],
  );
});

test('invoke starts Toolkit roots before evaluating runtime-dependent availability', async () => {
  const events: string[] = [];
  let started = false;
  const { graph, calls } = makeStubGraph([
    { messages: [new AIMessage('done')] },
  ]);
  const toolkitRuntimeManager = new ToolkitRuntimeManager();
  const runtime = createPetAgentRuntime({
    models: fakeModels(),
    actor: fakeActor(),
    capabilities: [{
      name: 'inspect',
      description: 'Inspect through a runtime-backed Toolkit.',
      uses: ['runtime_ready'],
      instructions: defineInstructionDocument({ content: '# Inspect' }),
    }],
    toolkits: [{
      name: 'runtime_ready',
      description: 'Available only after its root starts.',
      tools: [{ tool: mockTool('runtime_ready_tool') }],
      runtime: {
        start: () => {
          events.push('start');
          started = true;
          return {};
        },
        stop: () => {
          events.push('stop');
        },
      },
      availability: () => {
        events.push('availability');
        return started
          ? { available: true }
          : { available: false, reason: 'root not started' };
      },
    }],
    graph,
    toolkitRuntimeManager,
  });

  await runtime.invoke({ brief: 'inspect' });
  const registry = (calls[0]?.options as {
    configurable?: { registry?: { capabilities?: Array<{ capability: { name: string } }> } };
  } | undefined)?.configurable?.registry;
  assert.deepEqual(events, ['start', 'availability']);
  assert.deepEqual(registry?.capabilities?.map(({ capability }) => capability.name), ['inspect']);

  await toolkitRuntimeManager.stop();
  assert.deepEqual(events, ['start', 'availability', 'stop']);
});

test('humanReviewer: single interrupt → approve → reply', async () => {
  const requests: HumanReviewerRequest[] = [];
  const { graph } = makeStubGraph([
    { __interrupt__: [{ value: sampleReviewInterrupt }], messages: [] },
    { messages: [new AIMessage('all done')] },
  ]);

  const runtime = createPetAgentRuntime({
    models: fakeModels(),
    actor: fakeActor(),
    graph,
    humanReviewer: async (req) => {
      requests.push(req);
      return {
        reviewId: req.review.id,
        selectedOptionId: 'approve',
      };
    },
  });

  const result = await runtime.invoke({ brief: 'go' });
  assert.equal(result.reply, 'all done');
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.kind, 'review');
  assert.equal(requests[0]?.review.id, 'review-direct');
});

test('humanReviewer: multi-round interrupt loops until resolved', async () => {
  const requests: HumanReviewerRequest[] = [];
  const { graph } = makeStubGraph([
    { __interrupt__: [{ value: sampleReviewInterrupt }], messages: [] },
    { __interrupt__: [{ value: sampleReviewInterrupt }], messages: [] },
    { messages: [new AIMessage('done after two reviews')] },
  ]);

  const runtime = createPetAgentRuntime({
    models: fakeModels(),
    actor: fakeActor(),
    graph,
    humanReviewer: async (req) => {
      requests.push(req);
      return {
        reviewId: req.review.id,
        selectedOptionId: 'approve',
      };
    },
  });

  const result = await runtime.invoke({ brief: 'go' });
  assert.equal(result.reply, 'done after two reviews');
  assert.equal(requests.length, 2);
});

test('humanReviewer: canonical review interrupt → approve → reply', async () => {
  const requests: HumanReviewerRequest[] = [];
  const { graph } = makeStubGraph([
    { __interrupt__: [{ value: sampleReviewInterrupt }], messages: [] },
    { messages: [new AIMessage('direct done')] },
  ]);

  const runtime = createPetAgentRuntime({
    models: fakeModels(),
    actor: fakeActor(),
    graph,
    humanReviewer: async (req) => {
      requests.push(req);
      return {
        reviewId: req.review.id,
        selectedOptionId: 'approve',
      };
    },
  });

  const result = await runtime.invoke({ brief: 'go' });
  assert.equal(result.reply, 'direct done');
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request?.kind, 'review');
  assert.equal(request?.kind === 'review' ? request.review.id : null, 'review-direct');
});

test('humanReviewer: missing reviewer + interrupt → invoke throws', async () => {
  const { graph } = makeStubGraph([
    { __interrupt__: [{ value: sampleReviewInterrupt }], messages: [] },
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

test('humanReviewer: resume call passes canonical response Command', async () => {
  const { graph, calls } = makeStubGraph([
    { __interrupt__: [{ value: sampleReviewInterrupt }], messages: [] },
    { messages: [new AIMessage('approved')] },
  ]);

  const runtime = createPetAgentRuntime({
    models: fakeModels(),
    actor: fakeActor(),
    graph,
    humanReviewer: async () => ({
      reviewId: 'review-direct',
      selectedOptionId: 'approve',
    }),
  });

  await runtime.invoke({ brief: 'go' });

  assert.equal(calls.length, 2);
  // 第一次调用应为初始 turn input(普通 object,带 messages);Command 实例的是第二次。
  assert.equal(isCommand(calls[0].input), false);
  assert.equal(isCommand(calls[1].input), true);
  assert.deepEqual((calls[1].input as { resume: unknown }).resume, {
    reviewId: 'review-direct',
    selectedOptionId: 'approve',
  });
});

test('humanReviewer: unknown interrupt is not treated as HITL', async () => {
  // 假设 graph 抛出某种未知类型的 interrupt;pet runtime 应直接返回(reply 空),
  // 不调用 humanReviewer。
  let reviewerCalled = false;
  const { graph } = makeStubGraph([
    { __interrupt__: [{ value: { kind: 'other_kind' } }], messages: [] },
  ]);

  const runtime = createPetAgentRuntime({
    models: fakeModels(),
    actor: fakeActor(),
    graph,
    humanReviewer: async (req) => {
      reviewerCalled = true;
      return {
        reviewId: req.review.id,
        selectedOptionId: 'approve',
      };
    },
  });

  const result = await runtime.invoke({ brief: 'go' });
  assert.equal(reviewerCalled, false);
  assert.equal(result.reply, '');
});

test('humanReviewer: malformed review interrupt is not treated as HITL', async () => {
  let reviewerCalled = false;
  const { graph } = makeStubGraph([
    { __interrupt__: [{ value: { kind: 'review' } }], messages: [] },
  ]);

  const runtime = createPetAgentRuntime({
    models: fakeModels(),
    actor: fakeActor(),
    graph,
    humanReviewer: async (req) => {
      reviewerCalled = true;
      return {
        reviewId: req.review.id,
        selectedOptionId: 'approve',
      };
    },
  });

  const result = await runtime.invoke({ brief: 'go' });
  assert.equal(reviewerCalled, false);
  assert.equal(result.reply, '');
});

test('pet runtime does not replace an explicitly configured wiki Capability', async () => {
  const { graph, calls } = makeStubGraph([
    { messages: [new AIMessage('done')] },
  ]);
  const runtime = createPetAgentRuntime({
    models: fakeModels(),
    actor: fakeActor(),
    capabilities: [{
      name: 'wiki',
      description: 'Use an externally managed knowledge source.',
      uses: [],
      instructions: defineInstructionDocument({
        content: '# External Wiki',
      }),
    }],
    graph,
  });

  const result = await runtime.invoke({
    brief: 'read wiki',
    wikiRoot: '/tmp/pinpawo-test-wiki',
  });

  assert.equal(result.reply, 'done');
  const configurable = (calls[0]?.options as {
    configurable?: {
      registry?: {
        capabilities?: Array<{
          capability?: { name?: string; description?: string };
          toolkits?: Array<{ name?: string }>;
        }>;
      };
    };
  } | undefined)?.configurable;
  const wikiCapabilities = configurable?.registry?.capabilities
    ?.filter(({ capability }) => capability?.name === 'wiki');
  assert.equal(wikiCapabilities?.length, 1);
  assert.equal(
    wikiCapabilities?.[0]?.capability?.description,
    'Use an externally managed knowledge source.',
  );
  assert.deepEqual(wikiCapabilities?.[0]?.toolkits, []);
});
