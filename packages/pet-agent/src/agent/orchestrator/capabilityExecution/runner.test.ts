import { readFixtureDelivery, createDeliveryResult, withDeliveryCalls } from '../../../testing/capabilityDelivery';
import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { FakeToolCallingModel } from 'langchain';
import { createToolDeliverables } from '@pinpawo/agent-contracts';
import { z } from 'zod';
import type { AgentModels } from '../../../types/agent';
import { defineInstructionDocument, type CapabilityLifecycle } from '../../../types/capability';
import { defineToolkit, type AgentToolkit } from '../../../types/toolkit';
import type { SubagentRunInput } from '../../../types/subagent';
import { setAgentMessageMetadata } from '../../messages';
import { isDelegationBriefingMessage } from '../delegation/briefing';

import { compileAgentRegistry } from '../registry';
import { exactAuthorization } from '../../../autoReview/reviewAuthorizations';
import { createCapabilityExecutor, type CapabilityExecutionContext, type CapabilityExecutionInput } from './index';

const models = { act: { invoke: () => { throw new Error('Unexpected model call'); } } } as unknown as AgentModels;

function input(id = 'd1', toolkits: AgentToolkit[] = [], lifecycle?: CapabilityLifecycle): CapabilityExecutionInput {
  const registry = compileAgentRegistry({
    toolkits,
    capabilities: [{
      name: 'general', description: 'Execute a task.', uses: toolkits.map(({ name }) => name),
      instructions: defineInstructionDocument({ content: 'Execute the delegated task.' }), lifecycle,
    }],
  });
  return {
    capability: registry.capabilities[0],
    delegation: {
      id, runId: 'r1', taskId: 't1',
      userRequest: 'Prepare two documents.', task: `Prepare ${id}`, briefing: 'Execute the planned work and return evidence.',
    },
    history: [new HumanMessage({ id: 'user', content: 'Prepare two documents.' })],
  };
}

function hostContext(): CapabilityExecutionContext {
  return {
    review: { authorizations: [] },
    runnableConfig: { configurable: { thread_id: 'thread1' }, context: { workdir: '/workspace' } },
  };
}

function messageScope(request: CapabilityExecutionInput) {
  return {
    lane: `capability:${request.capability.capability.name}` as const,
    delegationId: request.delegation.id,
    runId: request.delegation.runId,
    taskId: request.delegation.taskId,
  };
}

function deliver(run: SubagentRunInput, text = 'Delivered') {
  const message = new AIMessage({ id: `result:${run.runtimeContext?.executionScope?.delegationId}`, content: text });
  return { messages: [...run.messages, message], deliverables: [], output: message.text };
}

function staticToolkit(): AgentToolkit {
  return defineToolkit({
    name: 'static', description: 'Static toolkit.',
    tools: [{ tool: tool(() => 'ok', { name: 'check', description: 'Check.', schema: z.object({}) }) }],
  });
}

test('executor uses main history and briefing without replaying child transcripts', async () => {
  const request = input();
  const own = setAgentMessageMetadata(new AIMessage({ id: 'own', content: 'Earlier attempt' }), messageScope(request));
  const foreign = setAgentMessageMetadata(new AIMessage({ id: 'foreign', content: 'Other private work' }), {
    ...messageScope(request), delegationId: 'd2',
  });
  const messages = Object.freeze([...request.history, own, foreign]);
  const before = messages.map((message) => message.toDict());
  const config = { configurable: { thread_id: 'thread1' }, signal: new AbortController().signal };
  const execute = createCapabilityExecutor({ models, runSubagent: async (run) => {
    assert.strictEqual(run.runnableConfig, config);
    assert.strictEqual(run.signal, config.signal);
    assert.deepEqual(run.messages.filter((message) => !isDelegationBriefingMessage(message)).map(({ id }) => id), ['user']);
    assert.equal(run.messages.filter(isDelegationBriefingMessage).length, 1);
    assert.equal(run.runtimeContext?.executionScope?.delegationId, 'd1');
    return deliver(run);
  } });
  const result = await execute({ ...request, history: messages }, { ...hostContext(), runnableConfig: config });
  assert.equal(result.status, 'returned');
  assert.equal(result.delivery?.scope.delegationId, 'd1');
  assert.equal(result.delivery?.text, 'Delivered');
  assert.deepEqual(messages.map((message) => message.toDict()), before);
});

test('executor returns explicit output without copying subagent messages', async () => {
  const execute = createCapabilityExecutor({ models, runSubagent: async (run) => ({
    messages: run.messages, deliverables: [], output: 'Final output independent of private history.',
  }) });
  const first = await execute(input(), hostContext());
  const second = await execute(input(), hostContext());
  assert.equal(first.status, 'returned');
  assert.equal(first.delivery?.text, 'Final output independent of private history.');
  assert.notEqual(first.delivery?.id, second.delivery?.id);
});

test('executor keeps collected references when finalize replaces the transcript and clears output', async () => {
  const deliverables = [{ uri: 'artifact://workspace/report', title: 'Report' }];
  const result = await createCapabilityExecutor({ models, runSubagent: async run => ({
    ...deliver(run), deliverables,
  }) })(input('d1', [], { finalize: () => ({ messages: [], output: null }) }), hostContext());

  assert.equal(result.status, 'missing_deliverable');
  assert.equal(result.delivery, null);
  assert.deepEqual(result.deliverables, deliverables);
});

for (const output of [null, '', '  ']) {
  test(`finalize can clear a delivery (${JSON.stringify(output)}) without changing child execution`, async () => {
    const result = await createCapabilityExecutor({ models, runSubagent: async (run) => deliver(run) })(
      input('d1', [], { finalize: () => ({ output }) }), hostContext(),
    );
    assert.equal(result.status, 'missing_deliverable');
    assert.equal(result.delivery, null);
  });
}

test('finalize can replace the delivery body', async () => {
  const toolkit = staticToolkit();
  const request = input('d1', [toolkit], { finalize: (result, context) => {
    assert.equal(context.delegationId, 'd1');
    assert.equal(result.output, 'Delivered');
    return { output: 'Finalized delivery' };
  } });
  const result = await createCapabilityExecutor({ models, runSubagent: async run => deliver(run) })(request, hostContext());
  assert.equal(result.delivery?.text, 'Finalized delivery');
});

for (const outcome of ['reject', 'cancel', 'missing_deliverable', 'error', 'aborted'] as const) {
  test(`${outcome} preserves the outcome`, async () => {
    const toolkit = staticToolkit();
    let finalized = false;
    const request = input('d1', [toolkit], { finalize: () => { finalized = true; } });
    const failure = new Error(outcome);
    const controller = new AbortController();
    const execute = createCapabilityExecutor({ models, runSubagent: async (run) => {
      if (outcome === 'error') throw failure;
      if (outcome === 'aborted') {
        controller.abort(failure);
        run.signal?.throwIfAborted();
      }
      const messages = [...run.messages, new AIMessage({ id: 'partial', content: 'Partial work' })];
      return { messages, deliverables: [{ uri: 'artifact://partial-report' }], output: null,
        ...(outcome === 'reject' || outcome === 'cancel' ? { reviewDecision: outcome } : {}),
      };
    } });
    if (outcome === 'error' || outcome === 'aborted') {
      await assert.rejects(execute(request, { ...hostContext(), runnableConfig: { signal: controller.signal } }), (error) => error === failure);
    } else {
      const result = await execute(request, hostContext());
      assert.equal(result.status, 'missing_deliverable');
      assert.equal(result.reviewDecision, outcome === 'reject' || outcome === 'cancel' ? outcome : undefined);
      assert.equal(result.delivery, null);
      assert.deepEqual(result.deliverables, [{ uri: 'artifact://partial-report' }]);
    }
    assert.equal(finalized, outcome === 'missing_deliverable');
  });
}

test('overlapping calls keep contexts, deliverables and authorizations separate', async () => {
  const toolkit = staticToolkit();
  let arrivals = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const seen: SubagentRunInput[] = [];
  const execute = createCapabilityExecutor({ models, runSubagent: async (run) => {
    seen.push(run);
    const id = run.runtimeContext!.executionScope!.delegationId;
    arrivals += 1;
    if (arrivals === 2) release();
    await barrier;
    assert.equal(run.runtimeContext?.executionScope?.delegationId, id);
    return { ...deliver(run, id), deliverables: [{ uri: `artifact://${id}` }] };
  } });
  const first = input('d1', [toolkit]);
  const second = input('d2', [toolkit]);
  const grants = Object.freeze([{
    toolName: 'check', matcher: exactAuthorization('d1'), source: 'human' as const, createdAt: '2026-09-10T00:00:00Z',
  }]);
  const [a, b] = await Promise.all([
    execute(first, { ...hostContext(), review: { authorizations: grants } }), execute(second, hostContext()),
  ]);
  assert.notStrictEqual(seen[0].messages, seen[1].messages);
  assert.notEqual(seen[0].messages.at(-1)?.id, seen[1].messages.at(-1)?.id);
  assert.deepEqual(a.deliverables, [{ uri: 'artifact://d1' }]);
  assert.deepEqual(b.deliverables, [{ uri: 'artifact://d2' }]);
  assert.deepEqual(a.toolAuthorizations, grants);
  assert.notStrictEqual(a.toolAuthorizations, grants);
  assert.deepEqual(b.toolAuthorizations, []);
  for (const [result, id] of [[a, 'd1'], [b, 'd2']] as const) {
    assert.equal(result.delivery?.scope.delegationId, id);
  }
});

test('incomplete delegation identity is rejected before any execution', async () => {
  const request = input();
  const execute = createCapabilityExecutor({ models, runSubagent: async () => { throw new Error('Must not execute'); } });
  await assert.rejects(execute({ ...request, delegation: { ...request.delegation, id: '' } }, hostContext()), /complete delegation identity/);
});

test('default executor still invokes the existing createAgent-based subagent wrapper', async () => {
  const result = await createCapabilityExecutor({
    models: { act: new FakeToolCallingModel({ toolCalls: [[]] }) },
  })(input(), hostContext());
  assert.equal(result.status, 'returned');
  assert.ok(result.delivery?.text);
});

test('static tools and finalize share the host config identity', async () => {
  let called = false;
  let finalized = false;
  const probe = tool((_args, runtime) => {
    called = true;
    assert.equal(runtime.context?.workdir, '/workspace');
    assert.deepEqual(runtime.context?.executionScope, {
      threadId: 'thread1', runId: 'r1', delegationId: 'd1', workdir: '/workspace',
    });
    return 'Verified runtime context.';
  }, { name: 'probe', description: 'Inspect runtime context.', schema: z.object({}) });
  const toolkit = defineToolkit({
    name: 'probe_toolkit', description: 'Inspect the shared execution identity.',
    tools: [{ tool: probe }],
  });
  const execute = createCapabilityExecutor({
    models: { act: new FakeToolCallingModel({ toolCalls: [
      [{ id: 'probe-call', name: 'probe', args: {} }], [],
    ] }) },
  });
  const result = await execute(input('d1', [toolkit], { finalize: (_result, context) => {
    finalized = true;
    assert.equal(context.threadId, 'thread1');
  } }), hostContext());
  assert.equal(result.status, 'returned');
  assert.equal(called, true);
  assert.equal(finalized, true);
});

test('real Capability tools preserve deliverable declarations alongside ordinary tool results', async () => {
  const declared = [
    { uri: 'artifact://workspace/report', title: 'Report' },
    { uri: 'https://example.com/pull/1' },
  ];
  const declaration = { ...createToolDeliverables(declared), source: 'report-tool' };
  const calls: string[] = [];
  const publish = tool(() => {
    calls.push('publish');
    return ['Published report.', declaration];
  }, {
    name: 'publish_report', description: 'Publish a report.', schema: z.object({}),
    responseFormat: 'content_and_artifact',
  });
  const plain = tool(() => {
    calls.push('plain');
    return 'Plain probe result.';
  }, { name: 'plain_probe', description: 'Read a plain result.', schema: z.object({}) });
  const metadata = tool(() => {
    calls.push('metadata');
    return ['Metadata probe result.', { fileCount: 1 }];
  }, {
    name: 'metadata_probe', description: 'Read unrelated tool metadata.', schema: z.object({}),
    responseFormat: 'content_and_artifact',
  });
  const toolkit = defineToolkit({
    name: 'reports', description: 'Prepare reports and inspect evidence.',
    tools: [{ tool: publish }, { tool: plain }, { tool: metadata }],
  });
  let finalized = false;
  const result = await createCapabilityExecutor({
    models: { act: new FakeToolCallingModel({ toolCalls: [[
      { id: 'publish-call', name: 'publish_report', args: {} },
      { id: 'plain-call', name: 'plain_probe', args: {} },
      { id: 'metadata-call', name: 'metadata_probe', args: {} },
    ], []] }) },
  })(input('d1', [toolkit], { finalize: (execution) => {
    finalized = true;
    const results = new Map(execution.messages.filter(ToolMessage.isInstance)
      .map(message => [message.tool_call_id, message]));
    assert.equal(results.size, 3);
    assert.equal(results.get('publish-call')?.content, 'Published report.');
    assert.deepEqual(results.get('publish-call')?.artifact, declaration);
    assert.equal(results.get('plain-call')?.content, 'Plain probe result.');
    assert.equal(results.get('plain-call')?.artifact, undefined);
    assert.equal(results.get('metadata-call')?.content, 'Metadata probe result.');
    assert.deepEqual(results.get('metadata-call')?.artifact, { fileCount: 1 });
  } }), hostContext());

  assert.equal(finalized, true);
  assert.deepEqual(calls.sort(), ['metadata', 'plain', 'publish']);
  assert.equal(result.status, 'returned');
  assert.ok(result.delivery?.text);
  assert.deepEqual(result.deliverables, declared);
});

test('real subagent execution accepts frozen history with stable IDs without changing it', async () => {
  const message = Object.freeze(new HumanMessage({ id: 'frozen-user', content: 'Prepare a document.' }));
  const before = message.toDict();
  const execute = createCapabilityExecutor({ models: { act: new FakeToolCallingModel({ toolCalls: [[]] }) } });
  const result = await execute({ ...input(), history: Object.freeze([message]) }, hostContext());
  assert.equal(result.status, 'returned');
  assert.deepEqual(message.toDict(), before);
});

for (const id of [undefined, '', '   ']) {
  test(`rejects history with ${JSON.stringify(id) ?? 'missing'} ID before execution without mutation`, async () => {
    const message = Object.freeze(new HumanMessage({ id, content: 'Prepare a document.' }));
    let executed = false;
    const execute = createCapabilityExecutor({ models, runSubagent: async (run) => {
      executed = true;
      return deliver(run);
    } });
    await assert.rejects(execute({ ...input(), history: [message] }, hostContext()), /history messages must have stable IDs/);
    assert.equal(message.id, id);
    assert.equal(executed, false);
  });
}

test('passes the complete formatted briefing to the model', async () => {
  const request = input();
  const briefing = '  # Current execution\n\n' + '- Preserve the supplied evidence.\n'.repeat(100) + '\nReturn a checked deliverable.  ';
  const execute = createCapabilityExecutor({ models, runSubagent: async run => {
    const briefings = run.messages.filter(isDelegationBriefingMessage);
    assert.equal(briefings.length, 1);
    assert.ok(briefings[0].text.includes(briefing));
    assert.equal(run.runtimeContext?.executionScope?.delegationId, request.delegation.id);
    return deliver(run);
  } });
  const result = await execute({ ...request, delegation: { ...request.delegation, briefing } }, hostContext());
  assert.equal(result.status, 'returned');
});

test('prior delivery directory derives from main history across runs without model-supplied references', async () => {
  const prior = createDeliveryResult({ id: 'prior-result', sourceLane: 'capability:general',
    delegationId: 'previous-delegation', runId: 'previous-run', deliveryId: 'previous-delivery',
    task: 'Verify the source data', result: 'Verified evidence remains in the tool result.', createdAt: '2026-09-15T00:00:00Z' });
  const orphan = createDeliveryResult({ id: 'orphan-result', sourceLane: 'capability:general',
    delegationId: 'orphan-delegation', runId: 'previous-run', deliveryId: 'orphan-delivery',
    task: 'Unpaired result', result: 'Not validated.', createdAt: '2026-09-15T00:00:00Z' });
  const request = input();
  const execute = createCapabilityExecutor({ models, runSubagent: async run => {
    const context = run.promptSections?.map(section => section.content).join('\n') ?? '';
    assert.ok(context.includes('previous-delegation'));
    assert.ok(context.includes('previous-delivery'));
    assert.ok(context.includes('Verify the source data'));
    assert.equal(context.includes('orphan-delegation'), false);
    assert.equal(context.includes('Verified evidence remains in the tool result.'), false);
    assert.ok(run.messages.some(message => message.id === prior.id));
    return deliver(run);
  } });
  await execute({ ...request, history: [...request.history, ...withDeliveryCalls([prior]), orphan] }, hostContext());
});


test('executor forwards invocation usage without reconstructing a transcript', async () => {
  const tokenUsage = { inputTokens: 30, outputTokens: 5, totalTokens: 35 };
  const execute = createCapabilityExecutor({ models, runSubagent: async run => ({
    ...deliver(run), tokenUsage,
  }) });
  const result = await execute(input(), hostContext());
  assert.deepEqual(result.tokenUsage, tokenUsage);
  assert.equal('messages' in result, false);
});
