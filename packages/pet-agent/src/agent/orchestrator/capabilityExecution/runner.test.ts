import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, RemoveMessage } from '@langchain/core/messages';
import { messagesStateReducer } from '@langchain/langgraph';
import { tool } from '@langchain/core/tools';
import { FakeToolCallingModel } from 'langchain';
import { z } from 'zod';
import type { AgentModels } from '../../../types/agent';
import type { CapabilityArtifactRef } from '../../../types/artifact';
import { defineInstructionDocument, type CapabilityLifecycle } from '../../../types/capability';
import { defineToolkit, type AgentToolkit } from '../../../types/toolkit';
import type { SubagentRunInput } from '../../../types/subagent';
import { getAgentMessageMetadata, queryAgentMessages, setAgentMessageMetadata } from '../../messages';
import { isDelegationBriefingMessage } from '../delegation/briefing';
import { getDelegationAnnounce } from '../delegation';
import { PauseTaskInterruptSignal } from '../interrupt/pauseTaskInterrupt';
import { compileAgentRegistry } from '../registry';
import { exactAuthorization } from '../review/reviewAuthorizations';
import { ToolkitRuntimeManager } from '../toolkitRuntime';
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
      id, runId: 'r1', traceId: 't1',
      mode: 'initial', userRequest: 'Prepare two documents.', task: `Prepare ${id}`, essentialContext: null,
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
    traceId: request.delegation.traceId,
  };
}

function deliver(run: SubagentRunInput, text = 'Delivered') {
  const message = new AIMessage({ id: `result:${run.runtimeContext?.executionScope?.delegationId}`, content: text });
  return { messages: [...run.messages, message], artifacts: run.artifacts ?? [], output: message.text };
}

function artifact(id: string): CapabilityArtifactRef {
  return {
    id, threadId: 'thread1', capabilityId: 'general', delegationId: id, runId: 'r1',
    kind: 'file', mimeType: 'text/plain', uri: `artifact:${id}`, sizeBytes: 1,
    createdAt: '2026-09-10T00:00:00Z',
  };
}

function runtimeToolkit(events: string[]): AgentToolkit {
  return defineToolkit({
    name: 'runtime', description: 'Execution-scoped toolkit.',
    tools: [{ tool: tool(() => 'ok', { name: 'check', description: 'Check.', schema: z.object({}) }) }],
    runtime: {
      start: async () => ({}),
      resolve: async (_root, context) => {
        events.push(`resolve:${context.execution.delegationId}`);
        return context.execution.delegationId;
      },
      release: async (binding) => { events.push(`release:${binding}`); },
    },
  });
}

test('executor scopes history and returns an unapplied handoff without persisting the briefing', async () => {
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
    assert.deepEqual(run.messages.filter((message) => !isDelegationBriefingMessage(message)).map(({ id }) => id), ['user', 'own']);
    assert.equal(run.messages.filter(isDelegationBriefingMessage).length, 1);
    assert.equal(run.runtimeContext?.executionScope?.delegationId, 'd1');
    return deliver(run);
  } });
  const result = await execute({ ...request, history: messages }, { ...hostContext(), runnableConfig: config });
  assert.equal(result.status, 'returned');
  assert.equal(result.delivery?.scope.delegationId, 'd1');
  assert.equal(result.delivery?.text, 'Delivered');
  assert.equal(result.privateMessages.some(isDelegationBriefingMessage), false);
  assert.equal(result.privateMessages.filter(getDelegationAnnounce).length, 0);
  assert.equal(result.privateMessages.some((message) => message instanceof RemoveMessage), false);
  assert.deepEqual(messages.map((message) => message.toDict()), before);
});

test('continuation retains its private scope and returns only this attempt as a new patch', async () => {
  const request = input();
  const prior = setAgentMessageMetadata(new AIMessage({ id: 'prior', content: 'First attempt' }), messageScope(request));
  const execute = createCapabilityExecutor({ models, runSubagent: async (run) => {
    assert.ok(run.messages.some(({ id }) => id === 'prior'));
    return deliver(run, 'Second attempt');
  } });
  const result = await execute({
    ...request, history: [...request.history, prior],
    delegation: { ...request.delegation, mode: 'continue', guidance: 'Verify the document.' },
  }, hostContext());
  assert.equal(result.delivery?.task, request.delegation.task);
  assert.equal(result.delivery?.text, 'Second attempt');
  assert.equal(result.privateMessages.some(({ id }) => id === 'prior'), false);
  assert.deepEqual(result.scope, messageScope(request));
});

test('retained capability history is private to the exact delegation and run after delivery', async () => {
  const request = input();
  const result = await createCapabilityExecutor({ models, runSubagent: async (run) => deliver(run) })(request, hostContext());
  const stored = messagesStateReducer([...request.history], result.privateMessages);
  assert.equal(stored.length, request.history.length + 1);
  assert.deepEqual(queryAgentMessages(stored).main().select().messages, request.history);
  assert.equal(queryAgentMessages(stored).delegation(messageScope(request)).select().messages[0]?.text, 'Delivered');
  assert.deepEqual(queryAgentMessages(stored).delegation({ ...messageScope(request), delegationId: 'd2' }).select().messages, []);
  assert.deepEqual(queryAgentMessages(stored).delegation({ ...messageScope(request), runId: 'r2' }).select().messages, []);
});

test('executor returns explicit output without requiring a matching private message', async () => {
  const execute = createCapabilityExecutor({ models, runSubagent: async (run) => ({
    messages: run.messages, artifacts: [], output: 'Final output independent of private history.',
  }) });
  const first = await execute(input(), hostContext());
  const second = await execute(input(), hostContext());
  assert.equal(first.status, 'returned');
  assert.equal(first.delivery?.text, 'Final output independent of private history.');
  assert.deepEqual(first.privateMessages, []);
  assert.notEqual(first.delivery?.id, second.delivery?.id);
});

for (const output of [null, '', '  ']) {
  test(`finalize can clear a delivery (${JSON.stringify(output)}) without deleting private history`, async () => {
    const result = await createCapabilityExecutor({ models, runSubagent: async (run) => deliver(run) })(
      input('d1', [], { finalize: () => ({ output }) }), hostContext(),
    );
    assert.equal(result.status, 'missing_deliverable');
    assert.equal(result.delivery, null);
    assert.equal(result.privateMessages.length, 1);
    assert.equal(result.privateMessages[0].text, 'Delivered');
  });
}

test('finalize can replace delivery and merge artifacts after runtime release', async () => {
  const events: string[] = [];
  const toolkit = runtimeToolkit(events);
  const manager = new ToolkitRuntimeManager();
  await manager.start([toolkit]);
  const ref = artifact('d1');
  const request = input('d1', [toolkit], { finalize: (result, context) => {
    assert.deepEqual(events, ['resolve:d1', 'release:d1']);
    assert.equal(context.delegationId, 'd1');
    context.recordCapabilityArtifact?.(ref);
    assert.equal(result.output, 'Delivered');
    return { output: 'Finalized delivery', artifactRefs: [ref] };
  } });
  try {
    const result = await createCapabilityExecutor({ models, toolkitRuntimeManager: manager, runSubagent: async (run) => {
      assert.equal(run.runtimeContext?.toolkitRuntimes?.runtime, 'd1');
      run.artifacts?.push(ref);
      return deliver(run);
    } })(request, hostContext());
    assert.equal(result.delivery?.text, 'Finalized delivery');
    assert.deepEqual(result.artifacts, [ref]);
  } finally {
    await manager.stop();
  }
});

for (const outcome of ['paused', 'missing_deliverable', 'error', 'aborted'] as const) {
  test(`${outcome} preserves the outcome and releases this execution's runtime`, async () => {
    const events: string[] = [];
    const toolkit = runtimeToolkit(events);
    const manager = new ToolkitRuntimeManager();
    await manager.start([toolkit]);
    let finalized = false;
    const request = input('d1', [toolkit], { finalize: () => { finalized = true; } });
    const failure = new Error(outcome);
    const controller = new AbortController();
    const execute = createCapabilityExecutor({ models, toolkitRuntimeManager: manager, runSubagent: async (run) => {
      if (outcome === 'error') throw failure;
      if (outcome === 'aborted') {
        controller.abort(failure);
        run.signal?.throwIfAborted();
      }
      const messages = [...run.messages, new AIMessage({ id: 'partial', content: 'Partial work' })];
      if (outcome === 'paused') throw new PauseTaskInterruptSignal({ kind: 'pause_task' }, { messages, artifacts: [artifact('d1')] });
      return { messages, artifacts: [], output: null };
    } });
    try {
      if (outcome === 'error' || outcome === 'aborted') {
        await assert.rejects(execute(request, { ...hostContext(), runnableConfig: { signal: controller.signal } }), (error) => error === failure);
      } else {
        const result = await execute(request, hostContext());
        assert.equal(result.status, outcome);
        assert.equal(result.delivery, null);
        assert.ok(result.privateMessages.some(({ id }) => id === 'partial'));
        assert.equal(result.artifacts.length, outcome === 'paused' ? 1 : 0);
      }
      assert.equal(finalized, outcome === 'missing_deliverable');
      assert.deepEqual(events, ['resolve:d1', 'release:d1']);
    } finally {
      await manager.stop();
    }
  });
}

test('overlapping calls keep contexts, bindings, artifacts and authorizations separate', async () => {
  const events: string[] = [];
  const toolkit = runtimeToolkit(events);
  const manager = new ToolkitRuntimeManager();
  await manager.start([toolkit]);
  let arrivals = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const seen: SubagentRunInput[] = [];
  const execute = createCapabilityExecutor({ models, toolkitRuntimeManager: manager, runSubagent: async (run) => {
    seen.push(run);
    const id = run.runtimeContext!.executionScope!.delegationId;
    run.artifacts!.push(artifact(id));
    arrivals += 1;
    if (arrivals === 2) release();
    await barrier;
    assert.equal(run.runtimeContext?.toolkitRuntimes?.runtime, id);
    return deliver(run, id);
  } });
  const first = input('d1', [toolkit]);
  const second = input('d2', [toolkit]);
  const grants = Object.freeze([{
    toolName: 'check', matcher: exactAuthorization('d1'), source: 'human' as const, createdAt: '2026-09-10T00:00:00Z',
  }]);
  try {
    const [a, b] = await Promise.all([
      execute(first, { ...hostContext(), review: { authorizations: grants } }), execute(second, hostContext()),
    ]);
    assert.notStrictEqual(seen[0].messages, seen[1].messages);
    assert.notStrictEqual(seen[0].artifacts, seen[1].artifacts);
    assert.notEqual(seen[0].messages.at(-1)?.id, seen[1].messages.at(-1)?.id);
    assert.deepEqual(a.artifacts.map(({ id }) => id), ['d1']);
    assert.deepEqual(b.artifacts.map(({ id }) => id), ['d2']);
    assert.deepEqual(a.toolAuthorizations, grants);
    assert.notStrictEqual(a.toolAuthorizations, grants);
    assert.deepEqual(b.toolAuthorizations, []);
    for (const [result, id] of [[a, 'd1'], [b, 'd2']] as const) {
      assert.equal(result.delivery?.scope.delegationId, id);
      const privateMessage = result.privateMessages.find((message) => !getDelegationAnnounce(message));
      assert.equal(getAgentMessageMetadata(privateMessage!).delegationId, id);
      assert.equal(events.filter((event) => event === `release:${id}`).length, 1);
    }
  } finally {
    await manager.stop();
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
  assert.equal(result.privateMessages.some(isDelegationBriefingMessage), false);
});

test('runtime bindings, real tools and finalize share the host config identity', async () => {
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
    runtime: {
      start: () => ({}),
      resolve: (_root, context) => {
        assert.equal(context.execution.threadId, 'thread1');
        assert.equal(context.execution.workdir, '/workspace');
        return {};
      },
    },
  });
  const manager = new ToolkitRuntimeManager();
  await manager.start([toolkit]);
  try {
    const execute = createCapabilityExecutor({
      models: { act: new FakeToolCallingModel({ toolCalls: [
        [{ id: 'probe-call', name: 'probe', args: {} }], [],
      ] }) },
      toolkitRuntimeManager: manager,
    });
    const result = await execute(input('d1', [toolkit], { finalize: (_result, context) => {
      finalized = true;
      assert.equal(context.threadId, 'thread1');
    } }), hostContext());
    assert.equal(result.status, 'returned');
    assert.equal(called, true);
    assert.equal(finalized, true);
  } finally {
    await manager.stop();
  }
});

test('real subagent execution accepts frozen history with stable IDs without changing it', async () => {
  const message = Object.freeze(new HumanMessage({ id: 'frozen-user', content: 'Prepare a document.' }));
  const before = message.toDict();
  const execute = createCapabilityExecutor({ models: { act: new FakeToolCallingModel({ toolCalls: [[]] }) } });
  const result = await execute({ ...input(), history: Object.freeze([message]) }, hostContext());
  assert.equal(result.status, 'returned');
  assert.deepEqual(message.toDict(), before);
  assert.equal(result.privateMessages.some(({ id }) => id === 'frozen-user'), false);
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
