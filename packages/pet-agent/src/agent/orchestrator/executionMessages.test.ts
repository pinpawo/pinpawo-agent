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
  task: 'Prepare a report.', briefing: 'Prepare the requested report.' };
const metadata = { runId: 'run', taskId: 'task', delegationId: execution.delegationId };
const result = { status: 'returned' as const, delivery: { id: 'delivery', task: execution.task, text: 'Report prepared.',
  scope: { lane: 'capability:general' as const, ...metadata } } };

function invocation() {
  return setAgentMessageMetadata(new AIMessage({ content: '', tool_calls: [{
    id: 'call', name: 'delegate_capability', args: execution,
  }] }), metadata);
}

test('new delegation records omit the retired artifacts field', () => {
  const message = createCapabilityExecutionMessage({ callId: 'call', execution, result, metadata });
  assert.equal(Object.hasOwn(message.artifact.result, 'artifacts'), false);
  assert.equal(Object.hasOwn(JSON.parse(message.content as string), 'artifacts'), false);
  const record = readCapabilityExecutionRecord(message);
  assert.equal(record?.kind, 'executed');
  if (record?.kind !== 'executed') throw new Error('Expected an execution record.');
  assert.equal(Object.hasOwn(record.result, 'artifacts'), false);
  assert.equal(readCapabilityExecutions([invocation(), message])[0]?.result.delivery?.text, 'Report prepared.');
});

test('historical execution records retain empty and nonempty artifact arrays when read', () => {
  const reference = { id: 'legacy', uri: 'capability-artifact://thread/t/delegation/d/artifact/a',
    metadata: { label: 'historical evidence' } };
  for (const artifacts of [[], [reference]]) {
    const message = new ToolMessage({ name: 'delegate_capability', tool_call_id: 'call',
      status: 'success', content: 'Historical model-facing content.',
      artifact: { kind: 'executed', execution, result: { ...result, artifacts } },
    });
    setAgentMessageMetadata(message, metadata);
    const before = JSON.stringify(message.artifact);
    const records = readCapabilityExecutions([invocation(), message]);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0]?.result.artifacts, artifacts);
    assert.equal(records[0]?.result.delivery?.text, result.delivery.text);
    assert.equal(JSON.stringify(message.artifact), before);
  }
});

test('optional legacy data does not weaken execution-record validation', () => {
  for (const invalid of [{ ...result, artifacts: 'invalid' }, { ...result, artifacts: ['invalid'] },
    { ...result, unexpected: true }]) {
    const message = new ToolMessage({ name: 'delegate_capability', tool_call_id: 'call', status: 'success',
      content: 'Invalid.', artifact: { kind: 'executed', execution, result: invalid } });
    assert.throws(() => readCapabilityExecutionRecord(message), /Corrupted delegate_capability record/);
  }
});
