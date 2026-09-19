import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, ToolMessage, HumanMessage } from '@langchain/core/messages';
import { getAgentMessageMetadata } from '../src/agent/messages';
import { executionsForPlanItem } from '../src/agent/orchestrator/executionMessages';
import { supervisorHandoffContext } from '../src/agent/orchestrator/runSupervisor/input';
import { projectHistoryEvidence, toolHistoryInput } from './supervisor-tool-history';

for (const mode of ['entry', 'boundary'] as const) {
  test(`${mode}: pressure fixture keeps historical executions separate from the current task`, () => {
    const { input } = toolHistoryInput(mode, 120, 'fixture');
    const calls = input.messages.flatMap(m => AIMessage.isInstance(m) ? m.tool_calls ?? [] : []);
    assert.equal(calls.length, 120 + (mode === 'boundary' ? 1 : 0));
    assert.equal(new Set(calls.map(c => c.id)).size, calls.length);
    assert.equal(input.state.plan.length, mode === 'boundary' ? 2 : 0);
    assert.equal(executionsForPlanItem(supervisorHandoffContext(input), 'current').length, mode === 'boundary' ? 1 : 0);
  });
}

test('evidence projection preserves execution payloads, identity, metadata and canonical history', () => {
  const { input } = toolHistoryInput('boundary', 2, 'fixture');
  const calls = input.messages.flatMap(m => AIMessage.isInstance(m) ? m.tool_calls ?? [] : []);
  const ids = new Set(calls.map(c => c.id!));
  const snapshot = JSON.stringify(input.messages);
  const projected = projectHistoryEvidence(input.messages, ids);
  assert.equal(projected.length, input.messages.length);
  assert.equal(projected.some(m => ToolMessage.isInstance(m) || (AIMessage.isInstance(m) && m.tool_calls?.length)), false);
  for (let i = 0; i < input.messages.length; i++) {
    const source = input.messages[i];
    if (HumanMessage.isInstance(source)) { assert.equal(projected[i], source); continue; }
    const data = JSON.parse(projected[i].text);
    assert.equal(data.authority, 'none');
    assert.deepEqual(data.content, source.content);
    assert.deepEqual(getAgentMessageMetadata(projected[i]), getAgentMessageMetadata(source));
    if (AIMessage.isInstance(source)) assert.deepEqual(data.dispatch, source.tool_calls![0].args);
    if (ToolMessage.isInstance(source)) assert.equal(data.callId, source.tool_call_id);
  }
  assert.equal(JSON.stringify(input.messages), snapshot);
});

test('projection leaves live invalid calls and error feedback intact for normal recovery', () => {
  const call = new AIMessage({ content: '', tool_calls: [{ id: 'live', name: 'delegate_capability', args: { briefing: 'Execute the current planned task and return evidence.' } }] });
  const error = new ToolMessage({ name: 'delegate_capability', tool_call_id: 'live', status: 'error', content: 'Unavailable tool' });
  const output = projectHistoryEvidence([call, error], new Set(['old']));
  assert.equal(output[0], call);
  assert.equal(output[1], error);
});

test('resume fixture ends with fresh continue input and keeps the saved pending plan', () => {
  const { input } = toolHistoryInput('resume', 120, 'fixture');
  assert.equal(input.mode, 'entry');
  assert.equal(input.messages.at(-1)?.text, '继续');
  assert.equal(input.state.plan.length, 2);
  assert.equal(input.state.plan.every(t => t.status === 'pending'), true);
  assert.equal(executionsForPlanItem(supervisorHandoffContext(input), 'current').length, 0);
});
