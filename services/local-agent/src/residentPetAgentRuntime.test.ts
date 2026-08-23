import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AIMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { isCommand } from '@langchain/langgraph';
import { z } from 'zod';

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createResidentPetAgentRuntime } from './residentPetAgentRuntime';
import { createOrchestratorGraph } from '@pinpawo/pet-agent';
import { FileSaver } from './fileSaver';
import type { OrchestratorGraph } from '@pinpawo/pet-agent';
import { ToolkitRuntimeManager } from '@pinpawo/pet-agent';
import type { AgentActor, AgentModels } from '@pinpawo/pet-agent';
import { defineInstructionDocument } from '@pinpawo/pet-agent';
import type { NamedStructuredTool } from '@pinpawo/pet-agent';

function fakeModels(): AgentModels {
  // Most tests stub the graph and never invoke this model. The one real-graph
  // construction test still needs a valid model because createAgent validates
  // its required model dependency when the Planner subgraph is created.
  return {
    act: new FakeListChatModel({ responses: ['unused'], sleep: 0 }),
  };
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
  const runtime = createResidentPetAgentRuntime({
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
  const runtime = createResidentPetAgentRuntime({
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

  await runtime.invoke({
    input: { kind: 'request', request: 'inspect' },
    threadId: 'studio:s1:pet:p1',
  });

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

test('resident Pet invocation preserves a checkpointed review as a waiting gate', async () => {
  const calls: { input: unknown; options?: unknown }[] = [];
  const graph = {
    invoke: async (input: unknown, options?: unknown) => {
      calls.push({ input, options });
      return { messages: [new AIMessage('waiting')] };
    },
    getState: async () => calls.length === 0
      ? { tasks: [], next: [] }
      : {
          tasks: [{ interrupts: [{ id: 'interrupt-1', value: sampleReviewInterrupt }] }],
        },
  } as unknown as OrchestratorGraph;
  const runtime = createResidentPetAgentRuntime({
    models: fakeModels(),
    actor: fakeActor(),
    graph,
    // A Host-owned checkpointer makes continuation inspection available. The
    // stub graph above models the durable snapshot returned by LangGraph.
    checkpoint: {} as NonNullable<Parameters<typeof createResidentPetAgentRuntime>[0]['checkpoint']>,
  });

  const result = await runtime.invoke({
    input: { kind: 'request', request: 'task that requires review' },
    threadId: 'studio:s1:pet:p1',
  });

  assert.deepEqual(
    (calls[0]?.options as {
      configurable?: { reviewCapabilities?: unknown };
    } | undefined)?.configurable?.reviewCapabilities,
    { humanReview: true, sessionAuthorization: true },
  );
  assert.equal(result.status, 'waiting');
  assert.equal(
    result.status === 'waiting'
      ? result.pendingContinuation.continuationId
      : null,
    'interrupt-1',
  );
  assert.equal(runtime.gate(), 'waiting');
});

test('resident Pet rejects a stale interrupt id without invoking or mutating the graph', async () => {
  let invokes = 0;
  const snapshot = {
    tasks: [{ interrupts: [{ id: 'interrupt-current', value: sampleReviewInterrupt }] }],
  };
  const graph = {
    invoke: async () => {
      invokes += 1;
      return { messages: [new AIMessage('unexpected')] };
    },
    getState: async () => snapshot,
  } as unknown as OrchestratorGraph;
  const runtime = createResidentPetAgentRuntime({
    models: fakeModels(),
    actor: fakeActor(),
    graph,
    checkpoint: {} as NonNullable<Parameters<typeof createResidentPetAgentRuntime>[0]['checkpoint']>,
  });

  await assert.rejects(
    () => runtime.invoke({
      input: {
        kind: 'resume',
        continuationId: 'interrupt-stale',
        payload: {
          kind: 'human_review_response',
          responses: [{
            interactionId: 'review-direct',
            selectedOptionId: 'approve',
          }],
        },
      },
      threadId: 'studio:s1:pet:p1',
    }),
    /stale.*interrupt-current/i,
  );
  assert.equal(invokes, 0);
  assert.equal(runtime.gate(), 'waiting');
  assert.equal((await graph.getState({} as never)), snapshot);
});

test('resident Pet resumes a matching interrupt through a keyed LangGraph Command', async () => {
  let waiting = true;
  const calls: unknown[] = [];
  const graph = {
    invoke: async (input: unknown) => {
      calls.push(input);
      waiting = false;
      return { messages: [new AIMessage('resumed')] };
    },
    getState: async () => waiting
      ? {
          tasks: [{ interrupts: [{ id: 'interrupt-1', value: sampleReviewInterrupt }] }],
        }
      : { tasks: [], next: [] },
  } as unknown as OrchestratorGraph;
  const runtime = createResidentPetAgentRuntime({
    models: fakeModels(),
    actor: fakeActor(),
    graph,
    checkpoint: {} as NonNullable<Parameters<typeof createResidentPetAgentRuntime>[0]['checkpoint']>,
  });

  const result = await runtime.invoke({
    input: {
      kind: 'resume',
      continuationId: 'interrupt-1',
      payload: {
        kind: 'human_review_response',
        responses: [{
          interactionId: 'review-direct',
          selectedOptionId: 'approve',
        }],
      },
    },
    threadId: 'studio:s1:pet:p1',
  });

  assert.equal(result.status, 'completed');
  assert.equal(runtime.gate(), 'open');
  assert.equal(calls.length, 1);
  assert.ok(isCommand(calls[0]));
  assert.deepEqual((calls[0] as { resume?: unknown }).resume, {
    'interrupt-1': {
      decisions: [{ reviewId: 'review-direct', selectedOptionId: 'approve' }],
    },
  });
});

test('invoke starts Toolkit roots before evaluating runtime-dependent availability', async () => {
  const events: string[] = [];
  let started = false;
  const { graph, calls } = makeStubGraph([
    { messages: [new AIMessage('done')] },
  ]);
  const toolkitRuntimeManager = new ToolkitRuntimeManager();
  const runtime = createResidentPetAgentRuntime({
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

  await runtime.invoke({
    input: { kind: 'request', request: 'inspect' },
    threadId: 'studio:s1:pet:p1',
  });
  const registry = (calls[0]?.options as {
    configurable?: { registry?: { capabilities?: Array<{ capability: { name: string } }> } };
  } | undefined)?.configurable?.registry;
  assert.deepEqual(events, ['start', 'availability']);
  assert.deepEqual(registry?.capabilities?.map(({ capability }) => capability.name), ['inspect']);

  await toolkitRuntimeManager.stop();
  assert.deepEqual(events, ['start', 'availability', 'stop']);
});








test('a pet runtime built with a checkpointer exposes durable thread state', async () => {
  // #613:此前 Studio 从不传 checkpoint,pet 的 graph 因此跑在无 checkpoint
  // 状态 —— 执行进度只存在于内存,中断后无法 resume。这也是 Studio 私有
  // HITL 循环之所以必须"一路跑到底"的根因。
  //
  // 不提供 graph,让 runtime 走真实的 createOrchestratorGraph 路径;
  // getState 能否读取线程状态是 checkpointer 是否生效的可观察信号。
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinpawo-pet-checkpointer-'));
  const config = {
    models: fakeModels(),
    actor: fakeActor(),
    checkpoint: new FileSaver(path.join(dir, 'cp.json')),
  };

  const graph = createOrchestratorGraph({
    models: config.models,
    actor: config.actor,
    checkpoint: config.checkpoint,
  });
  const thread = { configurable: { thread_id: 'studio:s1:pet:p1:invocation:i1' } };
  await assert.doesNotReject(
    () => graph.getState(thread as never),
    'a configured checkpointer must make thread state readable',
  );

  // 反向断言:同样的 graph 配置去掉 checkpoint 后,getState 会因缺少
  // checkpointer 而失败 —— 证明上面的断言确实在检验 checkpointer。
  const withoutCheckpointer = createOrchestratorGraph({
    models: config.models,
    actor: config.actor,
  });
  await assert.rejects(
    () => withoutCheckpointer.getState(thread as never),
    /checkpointer/i,
  );

  await fs.rm(dir, { recursive: true, force: true });
});
