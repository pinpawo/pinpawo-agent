import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import { z } from 'zod';
import type { AgentModels } from '../../../types/agent';
import { defineInstructionDocument } from '../../../types/capability';
import { buildAgentRunnableConfig } from '../../runAgent';
import { readCapabilityExecutions } from '../executionMessages';
import { settleAbortedRun } from '../interrupt';
import { compileAgentRegistry } from '../registry';
import type { RunSupervisorInput } from '../runSupervisor/runner';
import { withScriptedDelegation } from '../runSupervisor/testing';
import { buildOrchestratorRunInput, type OrchestratorStateType } from '../state';
import { getInvokeOptions } from './config';
import { createOrchestratorGraph } from './graph';
import { delegationBoundary } from './nodes/delegationBoundary';

function fixture() {
  const objective = randomUUID();
  const secondObjective = randomUUID();
  const delivery = [randomUUID(), randomUUID()];
  const toolRuns: string[] = [];
  const entryInputs: BaseMessage[][] = [];
  const supervisorInputs: RunSupervisorInput[] = [];
  const responses = delivery.flatMap((text, index) => [
    new AIMessage({ content: '', tool_calls: [{
      id: `evidence-${index}`, name: 'record_evidence', args: { value: text },
    }] }),
    new AIMessage(text),
  ]);
  class Executor extends BaseChatModel {
    _llmType() { return 'delegation-boundary-test'; }
    bindTools() { return this; }
    async _generate() {
      const message = responses.shift();
      assert.ok(message, 'completed tools must not be replayed');
      return { generations: [{ message, text: message.text }] };
    }
  }
  const entry = { bindTools: () => ({ invoke: async (messages: BaseMessage[]) => {
    entryInputs.push(messages);
    return new AIMessage({ content: '', tool_calls: [{
      id: `entry-${entryInputs.length}`, name: entryInputs.length === 1 ? 'plan_request' : 'continue',
      args: entryInputs.length === 1 ? { goal: objective } : {},
    }] });
  } }) } as unknown as AgentModels['act'];
  const registry = compileAgentRegistry({
    capabilities: [{ name: 'general', description: 'Collect evidence.', uses: ['evidence'],
      instructions: defineInstructionDocument({ content: 'Return the requested evidence.' }),
    }],
    toolkits: [{ name: 'evidence', description: 'Record evidence.', tools: [{ tool: tool(({ value }) => {
      toolRuns.push(value);
      return value;
    }, { name: 'record_evidence', description: 'Record one evidence item.', schema: z.object({ value: z.string() }) }) }] }],
  });
  const graph = createOrchestratorGraph({
    models: { act: entry, answer: entry, subagent: new Executor({}) },
    checkpoint: new MemorySaver(),
    runSupervisorRunner: withScriptedDelegation({ invoke: async (input) => {
      supervisorInputs.push(input);
      if (input.mode === 'entry') return { name: 'submit_plan', args: { tasks: [
        { capability: 'general', objective }, { capability: 'general', objective: secondObjective },
      ] } };
      return { name: 'review_current', args: { completed: true, reason: randomUUID(),
        ...(input.state.plan[0].status === 'completed' ? { reply: randomUUID() } : {}),
      } };
    } }),
  });
  const config = buildAgentRunnableConfig({ messages: [], threadId: randomUUID() }, { registry });
  return { graph, config, objective, delivery, toolRuns, entryInputs, supervisorInputs };
}

test('a boundary abort preserves returned delivery for the next fresh Entry continue without replay', async () => {
  const run = fixture();
  const controller = new AbortController();
  let boundaryCalls = 0;
  await assert.rejects(run.graph.invoke(buildOrchestratorRunInput([new HumanMessage(run.objective)]), {
    ...run.config,
    signal: controller.signal,
    configurable: { ...run.config.configurable, onDelegationComplete: async () => {
      boundaryCalls++;
      assert.equal(run.toolRuns.length, boundaryCalls);
      if (boundaryCalls === 2) controller.abort();
    } },
  }));
  const interrupted = (await run.graph.getState(run.config)).values as OrchestratorStateType;
  assert.equal(controller.signal.aborted, true);
  assert.equal(boundaryCalls, 2);
  assert.equal(run.supervisorInputs.length, 2, 'no Supervisor call runs after the abort');
  assert.equal(interrupted.runIterationCount, 2);
  assert.deepEqual(interrupted.runSupervisorState.plan.map(task => task.status), ['completed', 'pending']);
  const executions = readCapabilityExecutions(interrupted.messages);
  assert.deepEqual(executions.map(execution => execution.result?.delivery?.text), run.delivery);
  assert.ok(executions.every(execution => execution.result?.status === 'returned'));
  assert.equal(await settleAbortedRun({ getState: () => run.graph.getState(run.config) }), null);

  const incoming = new HumanMessage({ id: randomUUID(), content: randomUUID() });
  const next = await run.graph.invoke(buildOrchestratorRunInput([incoming]), run.config);
  assert.equal(run.entryInputs.length, 2);
  assert.ok(run.entryInputs[1].some(message => message.id === incoming.id && message.text === incoming.text));
  assert.notEqual(next.runId, interrupted.runId);
  assert.notEqual(next.taskId, interrupted.taskId);
  assert.equal(next.runSupervisorState.runId, next.runId);
  assert.equal(next.runSupervisorState.goal, interrupted.runSupervisorState.goal);
  assert.deepEqual(next.runSupervisorState.plan.map(task => task.id), interrupted.runSupervisorState.plan.map(task => task.id));
  assert.deepEqual(next.runSupervisorState.plan.map(task => task.status), ['completed', 'completed']);
  assert.deepEqual(readCapabilityExecutions(next.messages), executions);
  assert.deepEqual(run.toolRuns, run.delivery);
  assert.equal(run.supervisorInputs.length, 3);
  const resumed = run.supervisorInputs[2];
  assert.equal(resumed.mode, 'boundary');
  assert.equal(resumed.userRequest, incoming.text);
  assert.ok(resumed.messages.some(message => message.id === incoming.id));
  assert.equal(boundaryCalls, 2, 'the previous invocation hook does not leak into the new invocation');
});

for (const withHook of [false, true]) {
  test(`delegation completion ${withHook ? 'with a passive hook' : 'without a hook'} retains normal Supervisor acceptance`, async () => {
    const run = fixture();
    let boundaryCalls = 0;
    const config = { ...run.config, configurable: { ...run.config.configurable,
      ...(withHook ? { onDelegationComplete: () => { boundaryCalls++; } } : {}),
    } };
    const result = await run.graph.invoke(buildOrchestratorRunInput([new HumanMessage(run.objective)]), config);
    assert.deepEqual(result.runSupervisorState.plan.map(task => task.status), ['completed', 'completed']);
    assert.deepEqual(run.toolRuns, run.delivery);
    assert.equal(run.entryInputs.length, 1);
    assert.equal(run.supervisorInputs.length, 3);
    assert.equal(boundaryCalls, withHook ? 2 : 0);
    assert.deepEqual((await run.graph.getState(config)).next, []);
  });
}

test('delegation boundary checks cancellation before invoking and after awaiting its Host hook', async () => {
  const state = {} as OrchestratorStateType;
  const before = new AbortController();
  before.abort();
  let calls = 0;
  await assert.rejects(delegationBoundary(state, { signal: before.signal,
    configurable: { onDelegationComplete: () => { calls++; } },
  }), { name: 'AbortError' });
  assert.equal(calls, 0);

  const after = new AbortController();
  await assert.rejects(delegationBoundary(state, { signal: after.signal,
    configurable: { onDelegationComplete: async () => {
      await Promise.resolve();
      calls++;
      after.abort();
    } },
  }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('the invocation hook is a validated Host callback, absent by default', () => {
  const registry = compileAgentRegistry({ capabilities: [], toolkits: [] });
  const callback = async () => {};
  const config = buildAgentRunnableConfig({ messages: [], onDelegationComplete: callback }, { registry });
  assert.equal(getInvokeOptions(config).onDelegationComplete, callback);
  assert.equal(getInvokeOptions(buildAgentRunnableConfig({ messages: [] }, { registry })).onDelegationComplete, undefined);
  for (const malformed of [null, false, 'callback', [], {}]) {
    assert.throws(() => getInvokeOptions({ configurable: { onDelegationComplete: malformed } }));
  }
});
