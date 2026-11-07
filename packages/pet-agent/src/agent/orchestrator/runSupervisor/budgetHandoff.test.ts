import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { MemorySaver } from '@langchain/langgraph';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { defineInstructionDocument } from '../../../types/capability';
import { defineToolkit } from '../../../types/toolkit';
import { SUBAGENT_BUDGET_HANDOFF_EVENT } from '../../../subagent/createSubagent';
import { readCapabilityExecutions } from '../executionMessages';
import { compileAgentRegistry } from '../registry';
import { createOrchestratorGraph } from '../runtime/graph';
import { buildOrchestratorRunInput } from '../state';

function call(name: string, args: Record<string, unknown>, id: string) {
  return new AIMessage({ content: '', tool_calls: [{ name, args, id, type: 'tool_call' }] });
}

class ScriptedModel extends BaseChatModel {
  private index = 0;
  constructor(private readonly responses: AIMessage[]) { super({}); }
  _llmType() { return 'budget-handoff-script'; }
  bindTools() { return this; }
  async _generate() {
    const message = this.responses[this.index++];
    if (!message) throw new Error('Unexpected Supervisor invocation');
    return { generations: [{ message, text: message.text }] };
  }
}

class BudgetExecutor extends BaseChatModel {
  readonly inputs: BaseMessage[][] = [];
  readonly toolCounts: number[] = [];
  private boundToolCount = 0;
  _llmType() { return 'budget-handoff-executor'; }
  bindTools(tools: unknown[]) {
    this.boundToolCount = tools.length;
    return this;
  }
  async _generate(messages: BaseMessage[]) {
    this.inputs.push([...messages]);
    this.toolCounts.push(this.boundToolCount);
    const turn = this.inputs.length;
    const finalNotice = messages.some(message => ToolMessage.isInstance(message)
      && message.name === 'runtime_budget_status' && JSON.parse(message.text).phase === 'finalize');
    const message = finalNotice ? new AIMessage('Inspection partially complete; verification remains.')
      : turn <= 100 ? call('probe', {}, `probe-${turn}`) : new AIMessage('Verification complete.');
    return { generations: [{ message, text: message.text }] };
  }
}

function noticePhases(messages: BaseMessage[]) {
  const phases: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const result = messages[i];
    if (!ToolMessage.isInstance(result) || result.name !== 'runtime_budget_status') continue;
    const invocation = messages[i - 1];
    assert.ok(AIMessage.isInstance(invocation));
    assert.equal(invocation.additional_kwargs.pinpawo && (invocation.additional_kwargs.pinpawo as Record<string, unknown>).runtimeNotice, 'subagent_budget');
    assert.equal(result.additional_kwargs.pinpawo && (result.additional_kwargs.pinpawo as Record<string, unknown>).runtimeNotice, 'subagent_budget');
    assert.equal(invocation.tool_calls?.length, 1);
    assert.equal(invocation.tool_calls[0].name, 'runtime_budget_status');
    assert.equal(invocation.tool_calls[0].id, result.tool_call_id);
    const data = JSON.parse(result.text);
    assert.equal(typeof data.instruction, 'string');
    assert.ok(data.instruction.trim());
    assert.deepEqual([data.iteration, data.maxIterations, data.remainingModelCalls], data.phase === 'prepare' ? [91, 100, 10] : [100, 100, 1]);
    phases.push(data.phase);
  }
  return phases;
}

test('budget handoff returns partial work and permits a fresh delegation of the same pending plan item', async () => {
  let probes = 0;
  const toolkit = defineToolkit({
    name: 'probe_toolkit', description: 'Inspect evidence.',
    tools: [{ tool: tool(() => { probes += 1; return 'Observed.'; }, {
      name: 'probe', description: 'Inspect evidence.', schema: z.object({}),
    }) }],
  });
  const registry = compileAgentRegistry({ toolkits: [toolkit], capabilities: [{
    name: 'general', description: 'Inspect evidence.', uses: ['probe_toolkit'],
    instructions: defineInstructionDocument({ content: 'Inspect and report evidence.' }),
  }] });
  const task = { capability: 'general', objective: 'Inspect the repository.' };
  const supervisor = new ScriptedModel([
    call('submit_plan', { tasks: [task] }, 'plan'),
    call('delegate_capability', { briefing: 'Inspect the repository.' }, 'first'),
    call('review_current', { completed: false, reason: 'Verification remains.' }, 'retry'),
    call('delegate_capability', { briefing: 'Finish verification.' }, 'second'),
    call('review_current', { completed: true, reason: 'Verified.' }, 'accept'),
    new AIMessage('Done.'),
  ]);
  const executor = new BudgetExecutor({});
  const checkpoint = new MemorySaver();
  const graph = createOrchestratorGraph({
    models: { act: supervisor, answer: new ScriptedModel([call('plan_request', { goal: task.objective }, 'entry')]), subagent: executor },
    checkpoint,
  });
  const options = { configurable: { thread_id: 'budget-handoff', registry } };
  await graph.invoke(buildOrchestratorRunInput([new HumanMessage(task.objective)]), {
    ...options, interruptBefore: ['capability'],
  });
  const before = await graph.getState(options);
  const run = await graph.streamEvents(null, { ...options, version: 'v3', interruptBefore: ['runSupervisor'] });
  const events: Array<{ name?: unknown; data?: unknown }> = [];
  for await (const event of run) {
    if (event.method === 'custom') events.push(event.params.data as { name?: unknown; data?: unknown });
  }
  await run.output;
  const partial = await graph.getState(options);
  assert.equal(partial.values.runSupervisorState.plan[0].status, 'pending');
  assert.equal(partial.values.runSupervisorState.plan[0].id, before.values.runSupervisorState.plan[0].id);
  const firstResult = readCapabilityExecutions(partial.values.messages);
  assert.equal(firstResult.length, 1);
  assert.equal(firstResult[0].result.status, 'returned');
  assert.equal(firstResult[0].result.delivery?.text, 'Inspection partially complete; verification remains.');
  assert.equal(probes, 99);
  assert.equal(executor.inputs.length, 100);
  assert.ok(executor.toolCounts.slice(0, 100).every(count => count === executor.toolCounts[0] && count > 0));
  const systems = executor.inputs.slice(0, 100).map(messages => messages.find(message => message._getType() === 'system')?.text);
  assert.ok(systems[0]);
  assert.ok(systems.every(system => system === systems[0]));
  assert.deepEqual(noticePhases(executor.inputs[89]), []);
  assert.deepEqual(noticePhases(executor.inputs[90]), ['prepare']);
  assert.deepEqual(noticePhases(executor.inputs[98]), ['prepare']);
  assert.deepEqual(noticePhases(executor.inputs[99]), ['prepare', 'finalize']);
  const handoffEvents = events.filter(event => event.name === SUBAGENT_BUDGET_HANDOFF_EVENT).map(event => event.data);
  assert.equal(handoffEvents.length, 2);
  assert.deepEqual(handoffEvents[0], { iteration: 91, maxIterations: 100, remainingModelCalls: 10, phase: 'prepare', reason: 'model_calls' });
  assert.deepEqual(handoffEvents.at(-1), { iteration: 100, maxIterations: 100, remainingModelCalls: 1, phase: 'finalize', reason: 'model_calls' });

  const savedHistories: BaseMessage[][] = [];
  for await (const tuple of checkpoint.list(options)) {
    const messages = tuple.checkpoint.channel_values.messages;
    if (Array.isArray(messages)) savedHistories.push(messages as BaseMessage[]);
  }
  assert.ok(savedHistories.some(messages => {
    try { return JSON.stringify(noticePhases(messages)) === JSON.stringify(['prepare', 'finalize']); }
    catch { return false; }
  }), 'the child checkpoint retains both paired notices');

  const output = await graph.invoke(null, options);
  const executions = readCapabilityExecutions(output.messages);
  assert.equal(executions.length, 2);
  assert.deepEqual(executions.map(({ result }) => result.status), ['returned', 'returned']);
  assert.equal(executions[0].metadata.taskId, executions[1].metadata.taskId);
  assert.equal(executions[0].execution.planItemId, executions[1].execution.planItemId);
  assert.notEqual(executions[0].execution.delegationId, executions[1].execution.delegationId);
  assert.equal(output.runSupervisorState.plan[0].status, 'completed');
  assert.equal(executor.inputs.length, 101);
  const prior = executor.inputs[100].find(message => ToolMessage.isInstance(message) && message.name === 'delegate_capability') as ToolMessage | undefined;
  assert.ok(prior);
  assert.equal(JSON.parse(prior.text).delivery.text, firstResult[0].result.delivery?.text);
  const resultMessages = output.messages.filter((message: BaseMessage) => ToolMessage.isInstance(message) && message.name === 'delegate_capability') as ToolMessage[];
  assert.deepEqual(resultMessages.map(message => message.status), ['success', 'success']);
});

class ContextBudgetExecutor extends BaseChatModel {
  readonly inputs: BaseMessage[][] = [];
  readonly toolChoices: unknown[] = [];
  private boundToolChoice: unknown;
  _llmType() { return 'context-budget-handoff-executor'; }
  bindTools(_tools: unknown[], options?: Record<string, unknown>) {
    this.boundToolChoice = options?.tool_choice;
    return this;
  }
  async _generate(messages: BaseMessage[]) {
    this.inputs.push([...messages]);
    this.toolChoices.push(this.boundToolChoice);
    const turn = this.inputs.length;
    let message: AIMessage;
    if (turn === 1) {
      message = call('probe', {}, 'context-probe');
      message.usage_metadata = { input_tokens: 11_000, output_tokens: 10, total_tokens: 11_010 };
    } else if (turn === 2) {
      const notice = messages.find(message => ToolMessage.isInstance(message)
        && message.name === 'runtime_budget_status');
      assert.ok(notice, 'the next call receives a context handoff notice instead of a summary request');
      message = new AIMessage('Inspection partially complete; verification remains.');
    } else {
      assert.equal(turn, 3, 'continuation needs one final model call and no separate summarizer');
      message = new AIMessage('Verification complete.');
    }
    return { generations: [{ message, text: message.text }] };
  }
}

test('context handoff uses Supervisor review and a fresh delegation for the same pending plan item', async () => {
  let probes = 0;
  const toolkit = defineToolkit({
    name: 'context_probe_toolkit', description: 'Inspect evidence.',
    tools: [{ tool: tool(() => { probes += 1; return 'Observed private probe evidence.'; }, {
      name: 'probe', description: 'Inspect evidence.', schema: z.object({}),
    }) }],
  });
  const registry = compileAgentRegistry({ toolkits: [toolkit], capabilities: [{
    name: 'general', description: 'Inspect evidence.', uses: ['context_probe_toolkit'],
    instructions: defineInstructionDocument({ content: 'Inspect and report evidence.' }),
  }] });
  const task = { capability: 'general', objective: 'Inspect the repository.' };
  const supervisor = new ScriptedModel([
    call('submit_plan', { tasks: [task] }, 'context-plan'),
    call('delegate_capability', { briefing: 'Inspect the repository.' }, 'context-first'),
    call('review_current', { completed: false, reason: 'Verification remains.' }, 'context-retry'),
    call('delegate_capability', { briefing: 'Reuse the inspection and finish verification.' }, 'context-second'),
    call('review_current', { completed: true, reason: 'Verified.' }, 'context-accept'),
    new AIMessage('Done.'),
  ]);
  const executor = new ContextBudgetExecutor({});
  const graph = createOrchestratorGraph({
    models: { act: supervisor, answer: new ScriptedModel([call('plan_request', { goal: task.objective }, 'context-entry')]), subagent: executor },
    subagentContextWindowTokens: 12_000,
    checkpoint: new MemorySaver(),
  });
  const options = { configurable: { thread_id: 'context-budget-handoff', registry } };
  await graph.invoke(buildOrchestratorRunInput([new HumanMessage(task.objective)]), {
    ...options, interruptBefore: ['capability'],
  });
  const before = await graph.getState(options);
  const run = await graph.streamEvents(null, { ...options, version: 'v3', interruptBefore: ['runSupervisor'] });
  const events: Array<{ name?: unknown; data?: unknown }> = [];
  for await (const event of run) {
    if (event.method === 'custom') events.push(event.params.data as { name?: unknown; data?: unknown });
  }
  await run.output;
  const partial = await graph.getState(options);
  const firstResult = readCapabilityExecutions(partial.values.messages);
  assert.equal(partial.values.runSupervisorState.plan[0].status, 'pending');
  assert.equal(partial.values.runSupervisorState.plan[0].id, before.values.runSupervisorState.plan[0].id);
  assert.equal(firstResult.length, 1);
  assert.equal(firstResult[0].result.status, 'returned');
  assert.equal(firstResult[0].result.delivery?.text, 'Inspection partially complete; verification remains.');
  assert.equal(probes, 1);
  assert.equal(executor.inputs.length, 2, 'handoff is generated by the normal model call, without a summarizer');
  assert.equal(executor.toolChoices[1], 'none');
  const noticeIndex = executor.inputs[1].findIndex(message => ToolMessage.isInstance(message)
    && message.name === 'runtime_budget_status');
  assert.ok(noticeIndex > 0);
  const notice = executor.inputs[1][noticeIndex] as ToolMessage;
  const noticeCall = executor.inputs[1][noticeIndex - 1] as AIMessage;
  assert.ok(AIMessage.isInstance(noticeCall));
  assert.equal(noticeCall.tool_calls?.[0].id, notice.tool_call_id);
  const noticeData = JSON.parse(notice.text);
  assert.equal(noticeData.phase, 'finalize');
  assert.equal(noticeData.reason, 'context_window');
  assert.equal(noticeData.iteration, 2);
  const handoffEvents = events.filter(event => event.name === SUBAGENT_BUDGET_HANDOFF_EVENT)
    .map(event => event.data as { reason: string; phase: string });
  assert.equal(handoffEvents.length, 1);
  assert.equal(handoffEvents[0].reason, 'context_window');
  assert.equal(handoffEvents[0].phase, 'finalize');

  const output = await graph.invoke(null, options);
  const executions = readCapabilityExecutions(output.messages);
  assert.equal(executions.length, 2);
  assert.deepEqual(executions.map(({ result }) => result.status), ['returned', 'returned']);
  assert.equal(executions[0].metadata.taskId, executions[1].metadata.taskId);
  assert.equal(executions[0].execution.planItemId, executions[1].execution.planItemId);
  assert.notEqual(executions[0].execution.delegationId, executions[1].execution.delegationId);
  assert.equal(output.runSupervisorState.plan[0].status, 'completed');
  assert.equal(executor.inputs.length, 3);
  assert.equal(probes, 1);
  const continuation = executor.inputs[2];
  const prior = continuation.find(message => ToolMessage.isInstance(message)
    && message.name === 'delegate_capability') as ToolMessage | undefined;
  assert.ok(prior);
  assert.equal(JSON.parse(prior.text).delivery.text, firstResult[0].result.delivery?.text);
  assert.ok(continuation.every(message => !ToolMessage.isInstance(message)
    || (message.name !== 'probe' && message.name !== 'runtime_budget_status')));
  assert.ok(continuation.every(message => !AIMessage.isInstance(message)
    || !message.tool_calls?.some(call => call.name === 'probe')));
  assert.ok(executor.inputs.flat().every(message => message.additional_kwargs.lc_source !== 'summarization'));
});
