import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { readCapabilityExecutions } from '../../../packages/pet-agent/src/agent/orchestrator/executionMessages';
import { getAgentMessageMetadata } from '../../../packages/pet-agent/src/agent/messages';
import { ORCHESTRATOR_MAX_ITERATIONS } from '../../../packages/pet-agent/src/agent/orchestrator/runtime/constants';
import { buildRouteEvalInput } from './orchestrator-eval-fixtures';
import { target as routeTarget } from './orchestrator-route.eval';
import { target as flowTarget, messageHasLaneMeta } from './orchestrator-flow.mock-subagent.eval';
import { orchestratorFlowMockSubagentDataset } from './datasets/orchestrator-flow-mock-subagent';

class ScriptedModel extends BaseChatModel {
  readonly inputs: BaseMessage[][] = [];
  constructor(private readonly responses: AIMessage[]) { super({}); }
  _llmType() { return 'offline-eval-continuation'; }
  bindTools() { return this; }
  async _generate(messages: BaseMessage[]) {
    this.inputs.push([...messages]);
    const message = this.responses.shift();
    if (!message) throw new Error('Unexpected extra model call.');
    return { generations: [{ message, text: message.text }] };
  }
}
const call = (name: string, args: Record<string, unknown>, id = name) =>
  new AIMessage({ content: '', tool_calls: [{ name, args, id, type: 'tool_call' }] });

test('private-message probe ignores empty lane slots while detecting real private lanes', () => {
  for (const lane of [null, undefined, '']) {
    assert.equal(messageHasLaneMeta(new AIMessage({ content: 'Public evidence.', additional_kwargs: { pinpawo: { lane } } })), false);
  }
  assert.equal(messageHasLaneMeta(new AIMessage({ content: 'Private reply.',
    additional_kwargs: { pinpawo: { lane: 'capability:explore', delegationId: 'old', runId: 'old' } } })), true);
});

test('route fixtures pair current plan IDs with real public call/result evidence', () => {
  const input = buildRouteEvalInput({ user_message: 'Inspect and verify.',
    completed_tasks: ['Inspect.'], completed_results: ['Inspection evidence.'],
    progress_results: ['Verification partly done.', 'Verification needs one more check.'] });
  const records = readCapabilityExecutions(input.messages);
  assert.equal(records.length, 3);
  assert.deepEqual(input.runSupervisorState.plan.map(item => item.status), ['completed', 'pending']);
  for (const record of records) {
    assert.ok(input.runSupervisorState.plan.some(item => item.id === record.execution.planItemId));
    assert.equal(record.metadata.runId, input.runId);
    assert.equal(record.metadata.taskId, input.taskId);
    assert.equal(record.result.delivery?.scope.taskId, input.taskId);
  }
  assert.equal(input.messages.some(message => getAgentMessageMetadata(message).lane), false);
  for (const field of ['taskActiveDelegation', 'taskRunContinuation', 'runDelegationSummaries']) {
    assert.equal(field in input, false);
  }
});

test('route target answers from completed evidence without executing a Capability', async () => {
  const supervisor = new ScriptedModel([]);
  const result = await routeTarget({ user_message: 'Inspect.', completed_results: ['Inspection done.'] }, {
    answer: new ScriptedModel([new AIMessage('Inspection done.')]), act: supervisor,
  });
  assert.equal(result.route, 'answer');
  assert.equal(result.phase, 'after_subagent');
  assert.equal(supervisor.inputs.length, 0);
});

test('progress-only route target continues a pending plan without the old undefined summaries', async () => {
  const result = await routeTarget({ user_message: 'Finish verification.', progress_results: ['Partial evidence.'] }, {
    answer: new ScriptedModel([call('continue', {})]),
    act: new ScriptedModel([call('delegate_capability', { briefing: 'Complete the missing verification.' })]),
  });
  assert.equal(result.route, 'delegate');
  assert.equal(result.active_capability, 'general');
  assert.equal(result.phase, 'after_subagent');
});

test('explicit prior-run continuation reaches Entry continue and retains the explore plan', async () => {
  const fixture = { user_message: 'Continue.', resume_original_user_message: 'Investigate registration.',
    resume_progress_lane: 'capability:explore', resume_progress_task: 'Investigate registration.',
    resume_progress_result: 'Partial registration evidence.', capability_pack: 'explore' };
  const input = buildRouteEvalInput(fixture);
  assert.notEqual(input.runSupervisorState.runId, input.runId);
  assert.equal(input.runSupervisorState.plan[0].status, 'pending');
  const result = await routeTarget(fixture, { answer: new ScriptedModel([call('continue', {})]),
    act: new ScriptedModel([call('delegate_capability', { briefing: 'Complete registration evidence.' })]),
  });
  assert.equal(result.route, 'delegate');
  assert.equal(result.active_capability, 'explore');
  assert.equal(result.phase, 'initial_request', 'prior-run evidence is not a current-run execution');
});

test('flow target stops at the real Root budget, then explicit chat continues with public evidence', async () => {
  const fixture = orchestratorFlowMockSubagentDataset.cases
    .find(item => item.name === 'capability-budget-stop-explicit-input-continues-plan')!;
  const entry = new ScriptedModel([call('plan_request', { goal: fixture.input.user_message }), call('continue', {})]);
  const supervisor = new ScriptedModel([
    call('submit_plan', { tasks: [{ capability: 'explore', objective: fixture.input.user_message }] }),
    ...Array.from({ length: ORCHESTRATOR_MAX_ITERATIONS }, (_, i) => call('delegate_capability', { briefing: 'Collect the missing evidence.' }, `first:${i}`)),
    call('delegate_capability', { briefing: 'Reuse prior evidence and finish the investigation.' }, 'new-run'),
    call('review_current', { completed: true, reason: 'All registration evidence verified.' }),
    new AIMessage('Investigation complete.'),
  ]);
  const result = await flowTarget(fixture.input, { act: supervisor, answer: entry });
  assert.equal(entry.inputs.length, 2);
  assert.equal(result.follow_up_previous_iterations, ORCHESTRATOR_MAX_ITERATIONS);
  assert.equal(result.follow_up_run_count, 1);
  assert.equal(result.follow_up_fresh_run, true);
  assert.equal(result.follow_up_plan_preserved, true);
  assert.equal(result.follow_up_prior_delivery_seen, true);
  assert.equal(result.carryover_seen, false);
  assert.equal(result.delegation_count, ORCHESTRATOR_MAX_ITERATIONS + 1);
  assert.equal(result.latest_announce_lane, 'capability:explore');
  assert.equal(result.latest_announce_kind, 'completed');
  assert.equal(result.route, 'answer');
});

test('flow target also preserves the single-round completion path', async () => {
  const result = await flowTarget({ user_message: 'Inspect.', subagent_response: 'Inspection evidence.' }, {
    answer: new ScriptedModel([call('plan_request', { goal: 'Inspect.' })]),
    act: new ScriptedModel([
      call('submit_plan', { tasks: [{ capability: 'general', objective: 'Inspect.' }] }),
      call('delegate_capability', { briefing: 'Inspect.' }),
      call('review_current', { completed: true, reason: 'Inspection verified.' }), new AIMessage('Done.'),
    ]),
  });
  assert.equal(result.delegation_count, 1);
  assert.equal(result.follow_up_run_count, 0);
  assert.equal(result.route, 'answer');
});
