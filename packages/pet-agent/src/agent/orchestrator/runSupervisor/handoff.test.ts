import { readDelegationDeliveries, readCapabilityExecutions } from '../executionMessages';
import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { Command, MemorySaver, interrupt } from '@langchain/langgraph';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { createOrchestratorGraph } from '../runtime/graph';
import { buildOrchestratorRunInput } from '../state';
import { compileAgentRegistry } from '../registry';
import { defineInstructionDocument } from '../../../types/capability';
import { getDelegationAnnounce } from '../delegation';
import { getAgentMessageMetadata, queryAgentMessages } from '../../messages';
import { readCapabilityCall } from '../runtime/delegationToolResult';

class ScriptedModel extends BaseChatModel {
  readonly inputs: BaseMessage[][] = [];
  private index = 0;
  constructor(private readonly responses: AIMessage[]) { super({}); }
  _llmType() { return 'handoff-scripted'; }
  bindTools() { return this; }
  async _generate(messages: BaseMessage[]) {
    this.inputs.push(messages);
    const message = this.responses[this.index++];
    if (!message) throw new Error('Unexpected extra model invocation');
    return { generations: [{ message, text: message.text }] };
  }
}
const task = { capability: 'general', task: 'Inspect the repository.' };
function call(name: string, args: Record<string, unknown>, id: string) {
  return new AIMessage({ content: '', tool_calls: [{ name, args, id, type: 'tool_call' }] });
}
const registry = compileAgentRegistry({ toolkits: [], capabilities: [{
  name: 'general', description: 'Inspect repositories.', uses: [],
  instructions: defineInstructionDocument({ content: 'Inspect the repository and report evidence.' }),
}] });
function setup(checkpointer = new MemorySaver()) {
  const supervisor = new ScriptedModel([
    call('submit_plan', { tasks: [task] }, 'plan-call'),
    call('review_current', { completed: true, reason: 'Inspected.', reply: 'Inspection complete.' }, 'review-call'),
  ]);
  const executor = new ScriptedModel([new AIMessage({ content: 'Repository inspection evidence.' })]);
  const entry = new ScriptedModel([call('plan_request', { goal: task.task }, 'entry-call')]);
  const config = { models: { act: supervisor, answer: entry, subagent: executor }, checkpoint: checkpointer };
  return { supervisor, executor, config, graph: createOrchestratorGraph(config) };
}

test('real control handoff returns evidence to main and retains separate Supervisor work', async () => {
  const { graph, supervisor, executor } = setup();
  const output = await graph.invoke(buildOrchestratorRunInput([new HumanMessage(task.task)]), {
    configurable: { thread_id: 'real-handoff', registry },
  });
  assert.equal(executor.inputs.length, 1);
  assert.equal(supervisor.inputs.length, 2);
  const boundary = supervisor.inputs[1];
  const result = boundary.find((message) => ToolMessage.isInstance(message) && message.name === 'delegate_capability');
  assert.ok(result);
  assert.equal(JSON.parse(result.text).delivery.text, 'Repository inspection evidence.');
  assert.equal(boundary.filter((message) => message.text.includes('Repository inspection evidence.')).length, 1);
  assert.equal(output.messages.some(getDelegationAnnounce), false);
  assert.equal(output.messages.some((message) => ToolMessage.isInstance(message) && message.name === 'delegate_capability'), true);
  assert.equal(readDelegationDeliveries(output.messages).length, 1);
  assert.equal(output.runSupervisorState.plan[0].status, 'completed');
  assert.equal(output.messages.at(-1)?.text, 'Inspection complete.');
});

test('restart after dispatch restores pending call without repeating the planning model', async () => {
  const { graph, config, supervisor, executor } = setup();
  const options = { configurable: { thread_id: 'pending-handoff', registry } };
  await graph.invoke(buildOrchestratorRunInput([new HumanMessage(task.task)]), {
    ...options, interruptBefore: ['capability'],
  });
  const checkpoint = await graph.getState(options);
  const dispatched = readCapabilityCall(checkpoint.values);
  assert.ok(dispatched.id);
  assert.equal(queryAgentMessages(checkpoint.values.messages).supervisor(checkpoint.values.runId).select().messages
    .some((message) => HumanMessage.isInstance(message)), false);
  assert.equal(executor.inputs.length, 0);
  assert.equal(supervisor.inputs.length, 1);
  const rebuilt = createOrchestratorGraph(config);
  const output = await rebuilt.invoke(null, options);
  assert.equal(executor.inputs.length, 1);
  assert.equal(supervisor.inputs.length, 2);
  assert.equal(output.runSupervisorState.plan[0].status, 'completed');
  await rebuilt.invoke(null, options);
  assert.equal(executor.inputs.length, 1);
});

test('fresh run preserves Root facts without inheriting Supervisor work or deduplicating reused Entry call IDs', async () => {
  const checkpointer = new MemorySaver();
  const first = setup(checkpointer);
  const options = { configurable: { thread_id: 'session-two-runs', registry } };
  const firstOutput = await first.graph.invoke(buildOrchestratorRunInput([new HumanMessage(task.task)]), options);
  const second = setup(checkpointer);
  const secondOutput = await second.graph.invoke(buildOrchestratorRunInput([new HumanMessage(task.task)]), options);
  assert.notEqual(secondOutput.runId, firstOutput.runId);
  assert.equal(readDelegationDeliveries(secondOutput.messages).length, 2);
  assert.equal(secondOutput.messages.filter((message) => ToolMessage.isInstance(message)
    && message.name === 'plan_request' && message.tool_call_id === 'entry-call').length, 2);
  assert.ok(second.supervisor.inputs[0].some((message) => message.text === 'Inspection complete.'));
  assert.equal(second.supervisor.inputs[0].some((message) => getAgentMessageMetadata(message).lane === 'supervisor'
    && getAgentMessageMetadata(message).runId === firstOutput.runId), false);
  assert.equal(second.supervisor.inputs[0].some((message) => AIMessage.isInstance(message)
    && message.tool_calls?.some((call) => call.name === 'delegate_capability')), true);
});

test('unfinished task resumes in a new run from Root evidence, not the old Supervisor transcript', async () => {
  const { config } = setup();
  const firstSupervisor = new ScriptedModel([
    call('submit_plan', { tasks: [task] }, 'plan-question'),
    new AIMessage({ content: 'Which detail should be checked next?' }),
  ]);
  const options = { configurable: { thread_id: 'unfinished-new-run', registry } };
  const first = await createOrchestratorGraph({ ...config, models: { ...config.models, act: firstSupervisor } })
    .invoke(buildOrchestratorRunInput([new HumanMessage(task.task)]), options);
  assert.equal(first.runSupervisorState.plan[0].status, 'pending');
  const nextSupervisor = new ScriptedModel([new AIMessage({ content: 'I have the earlier evidence and your new guidance.' })]);
  const second = await createOrchestratorGraph({ ...config, models: { ...config.models, act: nextSupervisor, answer: new ScriptedModel([call('continue', {}, 'continue-entry')]) } })
    .invoke(buildOrchestratorRunInput([new HumanMessage('Check compatibility next.')]), options);
  assert.notEqual(second.runId, first.runId);
  assert.notEqual(second.traceId, first.traceId);
  assert.deepEqual(second.runSupervisorState, first.runSupervisorState);
  const messages = nextSupervisor.inputs[0];
  assert.ok(messages.some((message) => message.text.includes('Repository inspection evidence.')));
  assert.ok(messages.some((message) => message.text === 'Check compatibility next.'));
  assert.ok(messages.some((message) => ToolMessage.isInstance(message) && message.name === 'delegate_capability'));
  assert.equal(messages.some((message) => AIMessage.isInstance(message)
    && message.tool_calls?.some((call) => call.id === 'call-question')), false);
});

test('Entry continue executes unfinished work in a fresh private scope', async () => {
  const { config } = setup();
  const firstSupervisor = new ScriptedModel([
    call('submit_plan', { tasks: [task] }, 'plan-first'),
    new AIMessage('Verification remains; waiting for your input.'),
  ]);
  const options = { configurable: { thread_id: 'continue-fresh-executor', registry } };
  const first = await createOrchestratorGraph({ ...config, models: { ...config.models, act: firstSupervisor } })
    .invoke(buildOrchestratorRunInput([new HumanMessage(task.task)]), options);
  const nextSupervisor = new ScriptedModel([
    call('review_current', { completed: false, reason: 'Finish verification.' }, 'retry-next-run'),
    call('review_current', { completed: true, reason: 'Verification passed.', reply: 'Done.' }, 'accept-next-run'),
  ]);
  const executor = new ScriptedModel([new AIMessage('Fresh verification passed.')]);
  const second = await createOrchestratorGraph({ ...config, models: {
    act: nextSupervisor, subagent: executor, answer: new ScriptedModel([call('continue', {}, 'entry-continue')]),
  } }).invoke(buildOrchestratorRunInput([new HumanMessage('Continue with verification.')]), options);
  const before = readDelegationDeliveries(first.messages)[0].scope;
  const after = readDelegationDeliveries(second.messages).at(-1)!.scope;
  assert.notEqual(after.runId, before.runId);
  assert.notEqual(after.delegationId, before.delegationId);
  assert.equal(second.runSupervisorState.plan[0].id, first.runSupervisorState.plan[0].id);
  assert.equal(second.runSupervisorState.plan[0].status, 'completed');
  assert.equal(executor.inputs.length, 1);
  assert.equal(executor.inputs[0].some((message) => {
    const metadata = getAgentMessageMetadata(message);
    return metadata.lane === 'capability:general' && metadata.runId === before.runId;
  }), false);
  assert.ok(second.messages.some((message) => getAgentMessageMetadata(message).lane === 'capability:general'
    && getAgentMessageMetadata(message).runId === before.runId));
});

test('root stream retains node-level Capability model visibility after tool handoff', async () => {
  const { graph } = setup();
  const run = await graph.streamEvents(buildOrchestratorRunInput([new HumanMessage(task.task)]), {
    version: 'v3', configurable: { thread_id: 'handoff-stream', registry },
  });
  let capabilityModelEvents = 0;
  for await (const event of run) {
    if (event.method === 'messages' && event.params.namespace?.some((part) => part.startsWith('capability:'))) {
      capabilityModelEvents += 1;
    }
  }
  await run.output;
  assert.ok(capabilityModelEvents > 0, 'Capability messages must reach the native root stream');
});

test('committed result survives restart without repeating Capability execution', async () => {
  const { graph, config, supervisor, executor } = setup();
  const options = { configurable: { thread_id: 'completed-call-handoff', registry } };
  await graph.invoke(buildOrchestratorRunInput([new HumanMessage(task.task)]), {
    ...options, interruptAfter: ['capability'],
  });
  const checkpoint = await graph.getState(options);
  assert.equal(checkpoint.values.runSupervisorState.plan[0].status, 'pending');
  assert.ok(checkpoint.values.messages.some((message: BaseMessage) =>
    ToolMessage.isInstance(message) && message.name === 'delegate_capability'));
  assert.equal(executor.inputs.length, 1);
  assert.equal(supervisor.inputs.length, 1);
  await createOrchestratorGraph(config).invoke(null, options);
  assert.equal(executor.inputs.length, 1);
  assert.equal(supervisor.inputs.length, 2);
});

test('Capability interrupt resumes the same pending tool call through a rebuilt graph', async () => {
  const { config, supervisor } = setup();
  let effects = 0;
  const checked = tool(() => {
    const approved = interrupt({ kind: 'handoff_test_review' });
    assert.equal(approved, 'approved');
    effects += 1;
    return 'Checked once.';
  }, { name: 'check_repository', description: 'Check with approval.', schema: z.object({}) });
  const reviewedRegistry = compileAgentRegistry({
    toolkits: [{ name: 'checks', description: 'Checks.', tools: [{ tool: checked }] }],
    capabilities: [{ name: 'general', description: 'Inspect.', uses: ['checks'],
      instructions: defineInstructionDocument({ content: 'Inspect with check_repository.' }) }],
  });
  const executor = new ScriptedModel([
    call('check_repository', {}, 'inner-check'), new AIMessage({ content: 'Approved inspection evidence.' }),
  ]);
  const graphConfig = { ...config, models: { ...config.models, subagent: executor } };
  const graph = createOrchestratorGraph(graphConfig);
  const options = { configurable: { thread_id: 'review-handoff', registry: reviewedRegistry } };
  await graph.invoke(buildOrchestratorRunInput([new HumanMessage(task.task)]), options);
  const paused = await graph.getState(options);
  const dispatched = readCapabilityCall(paused.values);
  assert.ok(dispatched.id);
  assert.equal(effects, 0);
  assert.equal(supervisor.inputs.length, 1);
  const output = await createOrchestratorGraph(graphConfig).invoke(new Command({ resume: 'approved' }), options);
  assert.equal(effects, 1);
  assert.equal(supervisor.inputs.length, 2);
  assert.equal(readDelegationDeliveries(output.messages).length, 1);
  assert.equal(supervisor.inputs[1].filter((message) => ToolMessage.isInstance(message)
    && message.name === 'delegate_capability').length, 1);
});

test('multiple attempts keep both actual main tool results in one run', async () => {
  const { config } = setup();
  const supervisor = new ScriptedModel([
    call('submit_plan', { tasks: [task] }, 'plan-attempts'),
    call('review_current', { completed: false, reason: 'Verify the missing detail.' }, 'review-incomplete'),
    call('review_current', { completed: true, reason: 'Both results verified.', reply: 'Done.' }, 'review-complete'),
  ]);
  const executor = new ScriptedModel([
    new AIMessage({ content: 'First attempt evidence.' }), new AIMessage({ content: 'Second attempt evidence.' }),
  ]);
  const output = await createOrchestratorGraph({ ...config, models: { ...config.models, act: supervisor, subagent: executor } })
    .invoke(buildOrchestratorRunInput([new HumanMessage(task.task)]), {
      configurable: { thread_id: 'multiple-attempts', registry },
    });
  const results = supervisor.inputs.at(-1)!.filter((message) => ToolMessage.isInstance(message)
    && message.name === 'delegate_capability') as ToolMessage[];
  assert.equal(new Set(results.map((message) => message.tool_call_id)).size, 2);
  assert.deepEqual(results.map((message) => JSON.parse(message.text).delivery.text),
    ['First attempt evidence.', 'Second attempt evidence.']);
  assert.equal(new Set(readDelegationDeliveries(output.messages).map((delivery) => delivery.scope.delegationId)).size, 1);
  assert.equal(output.messages.some(getDelegationAnnounce), false);
});

test('missing delivery checkpoints an error result, leaves the plan untouched and lets Supervisor retry', async () => {
  const { config } = setup();
  const supervisor = new ScriptedModel([
    call('submit_plan', { tasks: [task] }, 'plan-missing'),
    call('review_current', { completed: false, reason: 'Produce the missing inspection report.' }, 'retry-missing'),
    call('review_current', { completed: true, reason: 'New report verified.', reply: 'Done.' }, 'accept-retry'),
  ]);
  const executor = new ScriptedModel([new AIMessage(''), new AIMessage('Fresh inspection evidence.')]);
  const graph = createOrchestratorGraph({ ...config, models: { ...config.models, act: supervisor, subagent: executor } });
  const options = { configurable: { thread_id: 'missing-delivery-retry', registry } };
  await graph.invoke(buildOrchestratorRunInput([new HumanMessage(task.task)]), {
    ...options, interruptBefore: ['capability'],
  });
  const dispatched = await graph.getState(options);
  await graph.invoke(null, { ...options, interruptBefore: ['runSupervisor'] });
  const failed = await graph.getState(options);
  assert.deepEqual(failed.values.runSupervisorState, dispatched.values.runSupervisorState);
  assert.equal(failed.values.runIterationCount, 1);
  assert.equal(failed.values.runTerminalError, null);
  assert.equal('sessionDelegationResults' in failed.values, false);
  assert.equal('taskPauseInterrupt' in failed.values, false);
  const failedMessage = failed.values.messages.at(-1) as ToolMessage;
  assert.equal(failedMessage.status, 'error');
  assert.equal(failedMessage.tool_call_id, readCapabilityCall(dispatched.values).id);
  assert.equal(readCapabilityExecutions(failed.values.messages).at(-1)?.result?.status, 'missing_deliverable');
  const output = await graph.invoke(null, options);
  const executions = readCapabilityExecutions(output.messages);
  assert.deepEqual(executions.map(({ result }) => result?.status), ['missing_deliverable', 'returned']);
  assert.notEqual(executions[0].call.id, executions[1].call.id);
  assert.equal(executions[0].execution.delegationId, executions[1].execution.delegationId);
  assert.equal(output.runSupervisorState.plan[0].status, 'completed');
  assert.equal(output.runIterationCount, 2);
  assert.equal(executor.inputs.length, 2);
});

test('Entry handoff checkpoints one canonical state and Supervisor reads it after restart', async () => {
  const { graph, config, supervisor } = setup();
  const options = { configurable: { thread_id: 'entry-canonical-state', registry } };
  await graph.invoke(buildOrchestratorRunInput([new HumanMessage(task.task)]), {
    ...options, interruptBefore: ['runSupervisor'],
  });
  const saved = await graph.getState(options);
  const main = queryAgentMessages(saved.values.messages).main().select().messages;
  const confirmation = main.at(-1) as ToolMessage;
  assert.equal(confirmation.name, 'plan_request');
  assert.equal(confirmation.tool_call_id, (main.at(-2) as AIMessage).tool_calls![0].id);
  assert.equal(supervisor.inputs.length, 0);
  const output = await createOrchestratorGraph(config).invoke(null, options);
  assert.equal(output.runSupervisorState.goal, saved.values.runUserRequest);
  assert.equal(output.runId, saved.values.runId);
  assert.equal(supervisor.inputs[0].some((message) => message.id === confirmation.id), true);
});

test('checkpointed Supervisor reply publishes once after restart without a reply state slot', async () => {
  const { graph, config, supervisor, executor } = setup();
  const options = { configurable: { thread_id: 'reply-from-messages', registry } };
  await graph.invoke(buildOrchestratorRunInput([new HumanMessage(task.task)]), { ...options, interruptBefore: ['answer'] });
  const saved = await graph.getState(options);
  assert.equal('runSupervisorReply' in saved.values, false);
  const output = await createOrchestratorGraph(config).invoke(null, options);
  assert.equal(supervisor.inputs.length, 2);
  assert.equal(executor.inputs.length, 1);
  const replies = queryAgentMessages(output.messages).main().select().messages.filter((message) => message.text === 'Inspection complete.');
  assert.equal(replies.length, 1);
  assert.equal(getAgentMessageMetadata(replies[0]).runId, output.runId);
});

test('Entry and preparation failures use the same checkpointed error exit as execution', async () => {
  for (const failedNode of ['entryAnswer', 'prepare']) {
    const { config } = setup();
    const graph = createOrchestratorGraph({ ...config, models: { ...config.models, answer: new ScriptedModel([]) } });
    const options = { configurable: { thread_id: `node-failure:${failedNode}`, registry } };
    const input = failedNode === 'prepare' ? { messages: [new HumanMessage('Uninitialized')] }
      : buildOrchestratorRunInput([new HumanMessage(task.task)]);
    await assert.rejects(graph.invoke(input, options), /initialized|Unexpected extra model invocation/);
    const saved = await graph.getState(options);
    assert.equal(saved.values.runTerminalError?.node, failedNode);
    assert.deepEqual(saved.next, ['throwRunFailure']);
    assert.equal(saved.values.runSupervisorState.plan.length, 0);
  }
});

test('Entry announcement repair can continue the saved plan instead of replacing it', async () => {
  const { graph, config } = setup();
  const options = { configurable: { thread_id: 'repair-entry-continue', registry } };
  await graph.invoke(buildOrchestratorRunInput([new HumanMessage(task.task)]), { ...options, interruptAfter: ['capability'] });
  const saved = await graph.getState(options);
  const executor = new ScriptedModel([]);
  const entry = new ScriptedModel([new AIMessage('我现在处理剩余任务。'), call('continue', {}, 'entry-repair-continue')]);
  const supervisor = new ScriptedModel([
    call('review_current', { completed: true, reason: 'Previous evidence verified.', reply: 'Done.' }, 'accept-old-evidence'),
  ]);
  const output = await createOrchestratorGraph({ ...config, models: { act: supervisor, answer: entry, subagent: executor } })
    .invoke(buildOrchestratorRunInput([new HumanMessage('Continue.')]), options);
  assert.equal(entry.inputs.length, 2);
  assert.equal(executor.inputs.length, 0);
  assert.equal(output.runSupervisorState.plan[0].id, saved.values.runSupervisorState.plan[0].id);
  assert.equal(output.runSupervisorState.plan[0].status, 'completed');
});
