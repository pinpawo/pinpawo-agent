import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { setAgentMessageMetadata } from '../messages';
import { readMainToolCallMessages } from './mainToolCalls';
import { createCapabilityExecutionMessage, createRejectedCapabilityExecutionMessage } from './executionMessages';
import { submitPlan } from './runSupervisor/submitPlanTool';
import { buildCapabilityExecutionInput } from './runSupervisor/delegateCapabilityTool';
import { supervisorWorkMessages } from './runSupervisor/workMessages';
import type { SupervisorControlContext } from './runSupervisor/controlContext';
import type { RunSupervisorState } from './runSupervisor/state';

const tasks = [{ capability: 'general', objective: 'Inspect A.' }, { capability: 'general', objective: 'Inspect B.' }];
function context(state: RunSupervisorState = { runId: null, goal: null, plan: [] }): SupervisorControlContext {
  return { state, runId: 'r1', taskId: 't1', userRequest: 'Inspect.', mode: 'entry', hasNewUserInput: true,
    allowedCapabilityNames: ['general'], messages: [] };
}
const planned = () => context(submitPlan(context(), { tasks }, 'plan'));
function dispatch(input: SupervisorControlContext, id: string, briefing: string, text = '') {
  return supervisorWorkMessages(input, [new AIMessage({ id, content: text,
    tool_calls: [{ name: 'delegate_capability', args: { briefing }, id, type: 'tool_call' }] })], true)[0] as AIMessage;
}
function returned(input: SupervisorControlContext, message: AIMessage, status: 'returned' | 'missing_deliverable', reviewDecision?: 'reject') {
  const callId = message.tool_calls![0].id!;
  const execution = buildCapabilityExecutionInput(input, { briefing: 'x' }, callId);
  return createCapabilityExecutionMessage({ callId, execution, metadata: { runId: 'r1', taskId: 't1' },
    result: status === 'returned'
      ? { status, artifacts: [], delivery: { id: 'd', task: execution.task, text: 'Done.', scope: {
        runId: 'r1', taskId: 't1', delegationId: execution.delegationId, lane: 'capability:general' } } }
      : { status, artifacts: [], delivery: null, ...(reviewDecision ? { reviewDecision } : {}) } });
}

test('Root delegations project with their plan item, briefing, text and outcome', () => {
  const input = planned();
  const first = dispatch(input, 'a', 'Look at A first.\nThen report.', 'Starting with A.');
  const second = dispatch(input, 'b', 'Look at B.');
  const messages = [new HumanMessage('Inspect.'), first, returned(input, first, 'returned'), second];
  const [done, running] = readMainToolCallMessages(messages, { runSupervisorState: { ...input.state, runId: 'r1',
    plan: input.state.plan.map((task, index) => index === 0 ? { ...task, status: 'completed' } : task) } });
  assert.equal(done!.text, 'Starting with A.');
  assert.deepEqual(done!.toolCalls.map(call => [call.name, call.title, call.input, call.status]), [
    ['delegate_capability', 'Inspect A.', 'Look at A first.\nThen report.', 'returned'],
  ]);
  assert.equal(done!.runId, 'r1');
  // Still running: its plan item comes from the state it was committed with.
  assert.deepEqual(running!.toolCalls.map(call => [call.title, call.status]), [['Inspect B.', 'running']]);
  // Without that state, the briefing's first line names it.
  assert.equal(readMainToolCallMessages(messages)[1]!.toolCalls[0]!.title, 'Look at B.');
});

test('declined, missing and rejected delegations keep distinct outcomes', () => {
  const input = planned();
  const statuses = [
    returned(input, dispatch(input, 'a', 'A'), 'missing_deliverable', 'reject'),
    returned(input, dispatch(input, 'b', 'B'), 'missing_deliverable'),
  ].map((result, index) => readMainToolCallMessages([dispatch(input, ['a', 'b'][index]!, 'x'), result])[0]!.toolCalls[0]!.status);
  assert.deepEqual(statuses, ['declined', 'missing']);
  const call = dispatch(input, 'c', 'C');
  const rejected = createRejectedCapabilityExecutionMessage({ callId: call.tool_calls![0].id!, content: 'no task', metadata: { runId: 'r1', taskId: 't1' } });
  assert.equal(readMainToolCallMessages([call, rejected])[0]!.toolCalls[0]!.status, 'failed');
});

test('private Supervisor work, synthetic messages and Entry routing are not conversation tool calls', () => {
  const input = planned();
  const [privateWork] = supervisorWorkMessages(input, [new AIMessage({ id: 'p', content: 'Planning.',
    tool_calls: [{ name: 'submit_plan', args: {}, id: 'p', type: 'tool_call' }] })]);
  const routing = setAgentMessageMetadata(new AIMessage({ id: 'e', content: '',
    tool_calls: [{ name: 'plan_request', args: { goal: 'x' }, id: 'e', type: 'tool_call' }] }), { runId: 'r1' });
  const synthetic = setAgentMessageMetadata(new AIMessage({ id: 's', content: '',
    tool_calls: [{ name: 'other', args: {}, id: 's', type: 'tool_call' }] }), { synthetic: true });
  assert.deepEqual(readMainToolCallMessages([privateWork!, routing, synthetic]), []);
});

test('other Root tools project generically by name and result status', () => {
  const call = setAgentMessageMetadata(new AIMessage({ id: 'm', content: '',
    tool_calls: [{ name: 'lookup', args: { q: 'x' }, id: 'call', type: 'tool_call' }] }), { runId: 'r1' });
  const failed = new ToolMessage({ tool_call_id: 'call', content: 'nope', status: 'error' });
  assert.deepEqual(readMainToolCallMessages([call, failed])[0]!.toolCalls, [
    { id: 'call', name: 'lookup', title: 'lookup', input: '{"q":"x"}', status: 'failed' },
  ]);
});
