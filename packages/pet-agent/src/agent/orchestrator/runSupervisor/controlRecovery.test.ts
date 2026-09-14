import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { MemorySaver } from '@langchain/langgraph';
import { createOrchestratorGraph } from '../runtime/graph';
import { buildOrchestratorRunInput } from '../state';
import { compileAgentRegistry } from '../registry';
import { defineInstructionDocument } from '../../../types/capability';
import { readCapabilityExecutions } from '../executionMessages';

class RecoveryModel extends BaseChatModel {
  readonly inputs: BaseMessage[][] = [];
  constructor(private readonly responses: AIMessage[]) { super({}); }
  _llmType() { return 'control-recovery'; }
  bindTools() { return this; }
  async _generate(messages: BaseMessage[]) {
    this.inputs.push([...messages]);
    const message = this.responses.shift();
    if (!message) throw new Error('Unexpected model invocation');
    return { generations: [{ message, text: message.text }] };
  }
}
function call(name: string, args: Record<string, unknown>, id: string) {
  return new AIMessage({ content: '', tool_calls: [{ name, args, id, type: 'tool_call' }] });
}
const task = { capability: 'general', task: 'Inspect the repository.' };
const registry = compileAgentRegistry({ toolkits: [], capabilities: [{
  name: 'general', description: 'Inspect repositories.', uses: [],
  instructions: defineInstructionDocument({ content: 'Inspect and report evidence.' }),
}] });

for (const name of ['submit_plan', 'adjust_plan', 'review_current', 'delegate_capability']) {
  test(`${name} schema error reaches the model and correction executes exactly once`, async () => {
    const badArgs = name === 'submit_plan' ? { tasks: [{ ...task, taskId: 'kanban-task' }] }
      : name === 'adjust_plan' ? { goal: task.task, reason: 'Correct the plan.', currentDelegation: 'replace', tasks: [{ ...task, taskId: 'kanban-task' }] }
      : name === 'review_current' ? { completed: 'yes', reason: 'Evidence returned.' }
      : { guidance: 123 };
    const goodPlan = call('submit_plan', { tasks: [task] }, 'plan');
    const execute = call('delegate_capability', {}, 'execute');
    const review = call('review_current', { completed: true, reason: 'Evidence returned.' }, 'review');
    const bad = call(name, badArgs, 'bad');
    const responses = name === 'review_current' ? [goodPlan, execute, bad, review]
      : name === 'delegate_capability' ? [goodPlan, bad, execute, review]
      : [bad, goodPlan, execute, review];
    const supervisor = new RecoveryModel([...responses, new AIMessage('Inspection complete.')]);
    const executor = new RecoveryModel([new AIMessage('Repository evidence.')]);
    const entry = new RecoveryModel([call('plan_request', { goal: task.task }, 'entry')]);
    const graph = createOrchestratorGraph({ models: { act: supervisor, answer: entry, subagent: executor }, checkpoint: new MemorySaver() });
    const result = await graph.invoke(buildOrchestratorRunInput([new HumanMessage(task.task)]), {
      configurable: { thread_id: `recover-${name}`, registry },
    });
    const feedback = supervisor.inputs.flat().find((m) => ToolMessage.isInstance(m) && m.tool_call_id === 'bad');
    assert.ok(ToolMessage.isInstance(feedback));
    assert.equal(feedback.status, 'error');
    assert.equal(feedback.name, name);
    assert.match(feedback.text, new RegExp(name === 'review_current' ? 'completed' : name === 'delegate_capability' ? 'guidance' : 'taskId'));
    assert.equal(executor.inputs.length, 1);
    assert.equal(readCapabilityExecutions(result.messages).length, 1);
    assert.equal(result.runSupervisorState.plan.length, 1);
    assert.equal(result.runSupervisorState.plan[0].status, 'completed');
    assert.equal(result.runSupervisorState.plan[0].task, task.task);
    assert.equal('taskId' in result.runSupervisorState.plan[0], false);
    assert.equal(result.messages.at(-1)?.text, 'Inspection complete.');
  });
}

for (const name of ['submit_plan', 'unknown_tool']) test(`repeated ${name} errors respect the caller loop limit without executing work`, async () => {
  const supervisor = new RecoveryModel(Array.from({ length: 30 }, (_, i) =>
    call(name, { tasks: [{ ...task, taskId: 'unexpected' }] }, `bad-${i}`)));
  const executor = new RecoveryModel([]);
  const entry = new RecoveryModel([call('plan_request', { goal: task.task }, 'entry')]);
  const graph = createOrchestratorGraph({ models: { act: supervisor, answer: entry, subagent: executor }, checkpoint: new MemorySaver() });
  await assert.rejects(graph.invoke(buildOrchestratorRunInput([new HumanMessage(task.task)]), {
    recursionLimit: 12, configurable: { thread_id: 'bounded-correction', registry },
  }), /Recursion limit/);
  assert.ok(supervisor.inputs.length > 1 && supervisor.inputs.length < 12);
  assert.equal(executor.inputs.length, 0);
});

for (const phase of ['entry', 'boundary']) {
  for (const name of ['unknown_tool', 'capability_details']) {
    // capability_details is unavailable only at Boundary without new input.
    if (phase === 'entry' && name === 'capability_details') continue;
    test(`${phase}: ${name} is corrected in the same run with exactly one delegation`, async () => {
      const plan = call('submit_plan', { tasks: [task] }, 'plan');
      const execute = call('delegate_capability', {}, 'execute');
      const review = call('review_current', { completed: true, reason: 'Evidence returned.' }, 'review');
      const bad = call(name, {}, 'unknown');
      const responses = phase === 'entry' ? [bad, plan, execute, review] : [plan, execute, bad, review];
      const supervisor = new RecoveryModel([...responses, new AIMessage('Inspection complete.')]);
      const executor = new RecoveryModel([new AIMessage('Repository evidence.')]);
      const entry = new RecoveryModel([call('plan_request', { goal: task.task }, 'entry')]);
      const graph = createOrchestratorGraph({ models: { act: supervisor, answer: entry, subagent: executor }, checkpoint: new MemorySaver() });
      const result = await graph.invoke(buildOrchestratorRunInput([new HumanMessage(task.task)]), {
        configurable: { thread_id: `unknown-${phase}-${name}`, registry },
      });
      const feedback = supervisor.inputs.flat().find(m => ToolMessage.isInstance(m) && m.tool_call_id === 'unknown');
      assert.ok(ToolMessage.isInstance(feedback));
      assert.equal(feedback.status, 'error');
      assert.equal(feedback.name, name);
      assert.equal(executor.inputs.length, 1);
      assert.equal(readCapabilityExecutions(result.messages).length, 1);
      assert.equal(result.runSupervisorState.plan.length, 1);
      assert.equal(result.runSupervisorState.plan[0].status, 'completed');
      assert.equal(result.messages.at(-1)?.text, 'Inspection complete.');
    });
  }
}

test('copied internal handoff parameters are corrected before a single Supervisor delegation', async () => {
  const supervisor = new RecoveryModel([
    call('submit_plan', { tasks: [task] }, 'plan'),
    call('delegate_capability', { control: { name: 'execute_current', args: {} },
      execution: { taskId: 'invented', capability: 'unauthorized' } }, 'copied-history'),
    call('delegate_capability', { guidance: 'Verify the concrete implementation.' }, 'delegate'),
    call('review_current', { completed: true, reason: 'Evidence returned.' }, 'review'),
    new AIMessage('Inspection complete.'),
  ]);
  const executor = new RecoveryModel([new AIMessage('Verified implementation evidence.')]);
  const entry = new RecoveryModel([call('plan_request', { goal: task.task }, 'entry')]);
  const graph = createOrchestratorGraph({ models: { act: supervisor, answer: entry, subagent: executor }, checkpoint: new MemorySaver() });
  const result = await graph.invoke(buildOrchestratorRunInput([new HumanMessage(task.task)]), {
    configurable: { thread_id: 'copied-handoff', registry },
  });
  const feedback = supervisor.inputs.flat().find(m => ToolMessage.isInstance(m) && m.tool_call_id === 'copied-history');
  assert.ok(ToolMessage.isInstance(feedback));
  assert.equal(feedback.status, 'error');
  const executions = readCapabilityExecutions(result.messages);
  assert.equal(executions.length, 1);
  assert.equal(executor.inputs.length, 1);
  assert.deepEqual(executions[0].call.args, { guidance: 'Verify the concrete implementation.' });
  const returnView = supervisor.inputs.at(-1)!;
  const actualResults = returnView.filter(m => ToolMessage.isInstance(m) && m.tool_call_id === executions[0].call.id);
  assert.equal(actualResults.length, 1);
  assert.ok(executor.inputs[0].some(m => m.text.includes('Verify the concrete implementation.')));
});
