import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { setAgentMessageMetadata } from '../messages';
import {
  createCapabilityExecutionMessage,
  readCapabilityExecutionRecord,
  readCapabilityExecutions,
} from './executionMessages';

const execution = { planItemId: 'item', delegationId: 'delegation', capability: 'general',
  goal: 'Prepare the requested report.', task: 'Prepare a report.', briefing: 'Prepare the requested report.' };
const metadata = { runId: 'run', taskId: 'task', delegationId: execution.delegationId };
const result = { status: 'returned' as const, delivery: { id: 'delivery', task: execution.task, text: 'Report prepared.',
  scope: { lane: 'capability:general' as const, ...metadata } } };

function invocation() {
  return setAgentMessageMetadata(new AIMessage({ content: '', tool_calls: [{
    id: 'call', name: 'delegate_capability', args: execution,
  }] }), metadata);
}

test('delegation records round-trip the current execution result and native call identity', () => {
  const message = createCapabilityExecutionMessage({ callId: 'call', execution, result, metadata });
  assert.deepEqual(JSON.parse(message.content as string), result);
  const record = readCapabilityExecutionRecord(message);
  assert.equal(record?.kind, 'executed');
  if (record?.kind !== 'executed') throw new Error('Expected an execution record.');
  assert.deepEqual(record.execution, execution);
  assert.deepEqual(record.result, result);
  assert.equal(readCapabilityExecutions([invocation(), message])[0]?.result.delivery?.text, 'Report prepared.');
});

test('execution records reject malformed fields and unknown result properties', () => {
  for (const invalid of [{ ...result, status: 'unknown' },
    { ...result, delivery: { ...result.delivery, text: ' ' } },
    { ...result, unexpected: true }]) {
    const message = new ToolMessage({ name: 'delegate_capability', tool_call_id: 'call', status: 'success',
      content: 'Invalid.', artifact: { kind: 'executed', execution, result: invalid } });
    assert.throws(() => readCapabilityExecutionRecord(message), /Corrupted delegate_capability record/);
  }
});
