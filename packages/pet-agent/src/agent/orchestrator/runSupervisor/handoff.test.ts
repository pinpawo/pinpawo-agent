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
    call('delegate_capability', task, 'execute-call'),
    call('review_current', { completed: true, reason: 'Inspected.', reply: 'Inspection complete.' }, 'review-call'),
  ]);
  const executor = new ScriptedModel([new AIMessage({ content: 'Repository inspection evidence.' })]);
  const entry = new ScriptedModel([call('plan_request', { goal: task.task }, 'entry-call')]);
  const config = { models: { act: supervisor, answer: entry, subagent: executor }, checkpoint: checkpointer };
  return { supervisor, executor, config, graph: createOrchestratorGraph(config) };
}

test('real delegation call returns evidence only to run-scoped tool history', async () => {
  const { graph, supervisor, executor } = setup();
  const output = await graph.invoke(buildOrchestratorRunInput([new HumanMessage(task.task)]), {
    configurable: { thread_id: 'real-handoff', registry },
  });
  assert.equal(executor.inputs.length, 1);
  assert.equal(supervisor.inputs.length, 3);
  const boundary = supervisor.inputs[2];
  const result = boundary.find((message) => ToolMessage.isInstance(message) && message.tool_call_id === 'execute-call');
  assert.ok(result);
  assert.equal(JSON.parse(result.text).delivery.text, 'Repository inspection evidence.');
  assert.equal(boundary.filter((message) => message.text.includes('Repository inspection evidence.')).length, 1);
  assert.equal(output.messages.some(getDelegationAnnounce), false);
  assert.equal(output.messages.some((message) => ToolMessage.isInstance(message) && message.tool_call_id === 'execute-call'), false);
  assert.equal(output.sessionDelegationResults.length, 1);
  assert.equal(output.runSupervisorSession, null);
  assert.equal(output.messages.at(-1)?.text, 'Inspection complete.');
});

test('restart after dispatch restores pending call without repeating the planning model', async () => {
  const { graph, config, supervisor, executor } = setup();
  const options = { configurable: { thread_id: 'pending-handoff', registry } };
  await graph.invoke(buildOrchestratorRunInput([new HumanMessage(task.task)]), {
    ...options, interruptBefore: ['capability'],
  });
  const checkpoint = await graph.getState(options);
  assert.equal(checkpoint.values.runSupervisorSession.pendingCall.id, 'execute-call');
  assert.deepEqual(checkpoint.values.runSupervisorSession.messages.filter((message: BaseMessage) =>
    HumanMessage.isInstance(message)).map((message: BaseMessage) => message.id),
  checkpoint.values.messages.filter((message: BaseMessage) => HumanMessage.isInstance(message))
    .map((message: BaseMessage) => message.id), 'invocation frames must not accumulate in run history');
  assert.equal(executor.inputs.length, 0);
  assert.equal(supervisor.inputs.length, 2);
  const rebuilt = createOrchestratorGraph(config);
  const output = await rebuilt.invoke(null, options);
  assert.equal(executor.inputs.length, 1);
  assert.equal(supervisor.inputs.length, 3);
  assert.equal(output.runSupervisorSession, null);
  await rebuilt.invoke(null, options);
  assert.equal(executor.inputs.length, 1);
});

test('fresh run preserves Root session facts but never inherits Supervisor tool history', async () => {
  const checkpointer = new MemorySaver();
  const first = setup(checkpointer);
  const options = { configurable: { thread_id: 'session-two-runs', registry } };
  const firstOutput = await first.graph.invoke(buildOrchestratorRunInput([new HumanMessage(task.task)]), options);
  const second = setup(checkpointer);
  const secondOutput = await second.graph.invoke(buildOrchestratorRunInput([new HumanMessage(task.task)]), options);
  assert.notEqual(secondOutput.runId, firstOutput.runId);
  assert.equal(secondOutput.sessionDelegationResults.length, 2);
  assert.ok(second.supervisor.inputs[0].some((message) => message.text === 'Inspection complete.'));
  assert.equal(second.supervisor.inputs[0].some((message) => ToolMessage.isInstance(message)), false);
  assert.equal(second.supervisor.inputs[0].some((message) => AIMessage.isInstance(message)
    && message.tool_calls?.some((call) => call.name === 'delegate_capability')), false);
});

test('unfinished task resumes in a new run from Root evidence, not the old Supervisor transcript', async () => {
  const { config } = setup();
  const firstSupervisor = new ScriptedModel([
    call('submit_plan', { tasks: [task] }, 'plan-question'),
    call('delegate_capability', task, 'call-question'),
    new AIMessage({ content: 'Which detail should be checked next?' }),
  ]);
  const options = { configurable: { thread_id: 'unfinished-new-run', registry } };
  const first = await createOrchestratorGraph({ ...config, models: { ...config.models, act: firstSupervisor } })
    .invoke(buildOrchestratorRunInput([new HumanMessage(task.task)]), options);
  assert.ok(first.taskRunContinuation?.activeDelegationId);
  assert.equal(first.runSupervisorSession, null);
  const nextSupervisor = new ScriptedModel([new AIMessage({ content: 'I have the earlier evidence and your new guidance.' })]);
  const second = await createOrchestratorGraph({ ...config, models: { ...config.models, act: nextSupervisor } })
    .invoke(buildOrchestratorRunInput([new HumanMessage('Check compatibility next.')], {
      activeDelegationTransition: 'resume_active',
    }), options);
  assert.notEqual(second.runId, first.runId);
  assert.equal(second.traceId, first.traceId);
  assert.equal(second.taskActiveDelegation?.id, first.taskActiveDelegation?.id);
  const messages = nextSupervisor.inputs[0];
  assert.ok(messages.some((message) => message.text.includes('Repository inspection evidence.')));
  assert.ok(messages.some((message) => message.text === 'Check compatibility next.'));
  assert.equal(messages.some((message) => ToolMessage.isInstance(message)), false);
  assert.equal(messages.some((message) => AIMessage.isInstance(message)
    && message.tool_calls?.some((call) => call.id === 'call-question')), false);
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
    ...options, interruptBefore: ['supervisorBoundaryIterationGuard'],
  });
  const checkpoint = await graph.getState(options);
  assert.equal(checkpoint.values.runSupervisorSession.pendingCall, null);
  assert.ok(checkpoint.values.runSupervisorSession.messages.some((message: BaseMessage) =>
    ToolMessage.isInstance(message) && message.tool_call_id === 'execute-call'));
  assert.equal(executor.inputs.length, 1);
  assert.equal(supervisor.inputs.length, 2);
  await createOrchestratorGraph(config).invoke(null, options);
  assert.equal(executor.inputs.length, 1);
  assert.equal(supervisor.inputs.length, 3);
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
  assert.equal(paused.values.runSupervisorSession.pendingCall.id, 'execute-call');
  assert.equal(effects, 0);
  assert.equal(supervisor.inputs.length, 2);
  const output = await createOrchestratorGraph(graphConfig).invoke(new Command({ resume: 'approved' }), options);
  assert.equal(effects, 1);
  assert.equal(supervisor.inputs.length, 3);
  assert.equal(output.sessionDelegationResults.length, 1);
  assert.equal(supervisor.inputs[2].filter((message) => ToolMessage.isInstance(message)
    && message.tool_call_id === 'execute-call').length, 1);
});

test('multiple attempts keep both actual tool results in one run without publishing them to main', async () => {
  const { config } = setup();
  const supervisor = new ScriptedModel([
    call('submit_plan', { tasks: [task] }, 'plan-attempts'),
    call('delegate_capability', task, 'attempt-1'),
    call('review_current', { completed: false, reason: 'Verify the missing detail.' }, 'review-incomplete'),
    call('delegate_capability', task, 'attempt-2'),
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
  assert.deepEqual(results.map((message) => message.tool_call_id), ['attempt-1', 'attempt-2']);
  assert.deepEqual(results.map((message) => JSON.parse(message.text).delivery.text),
    ['First attempt evidence.', 'Second attempt evidence.']);
  assert.equal(new Set(output.sessionDelegationResults.map((delivery) => delivery.scope.delegationId)).size, 1);
  assert.equal(output.messages.some(getDelegationAnnounce), false);
});
