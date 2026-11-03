import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolMessage } from '@langchain/core/messages';
import {
  createCapabilityExecutionMessage,
  readCapabilityExecutionRecord,
  type CapabilityExecutionResultRecord,
} from './executionMessages';

const deliverables = [
  { uri: 'artifact://workspace/report', title: 'Report', source: 'tool' },
  { uri: 'https://example.com/pull/1' },
];
const execution = {
  planItemId: 'plan-1', delegationId: 'delegation-1', capability: 'general',
  task: 'Publish a report.', briefing: 'Inspect the source and publish the report.',
};
const metadata = { runId: 'run-1', taskId: 'task-1' };
const returned: CapabilityExecutionResultRecord = {
  status: 'returned', deliverables,
  delivery: { id: 'delivery-1', task: execution.task, text: 'Report ready.', scope: {
    ...metadata, delegationId: execution.delegationId, lane: 'capability:general',
  } },
};

function message(result: CapabilityExecutionResultRecord) {
  return createCapabilityExecutionMessage({ callId: 'call-1', execution, result, metadata });
}

test('execution records retain declared references through JSON storage independently of content', () => {
  const original = message(returned);
  assert.deepEqual(JSON.parse(original.text).deliverables, deliverables);
  const stored = new ToolMessage({
    ...original,
    content: 'The display text may change without changing the execution record.',
    artifact: JSON.parse(JSON.stringify(original.artifact)),
  });
  const record = readCapabilityExecutionRecord(stored);
  assert.equal(record?.kind, 'executed');
  if (record?.kind !== 'executed') assert.fail('Expected an execution record.');
  assert.deepEqual(record.result.deliverables, deliverables);
});

for (const reviewDecision of ['reject', 'cancel'] as const) {
  test(`execution records keep references after review ${reviewDecision}`, () => {
    const result: CapabilityExecutionResultRecord = {
      status: 'missing_deliverable', delivery: null, reviewDecision, deliverables,
    };
    const original = message(result);
    const record = readCapabilityExecutionRecord(original);
    assert.equal(original.status, 'error');
    assert.equal(record?.kind, 'executed');
    if (record?.kind !== 'executed') assert.fail('Expected an execution record.');
    assert.equal(record.result.reviewDecision, reviewDecision);
    assert.deepEqual(record.result.deliverables, deliverables);
  });
}

test('execution records require a valid declaration and accept an explicitly empty list', () => {
  const original = message({ ...returned, deliverables: [] });
  assert.doesNotThrow(() => readCapabilityExecutionRecord(original));
  const record = original.artifact as { result: CapabilityExecutionResultRecord };
  for (const declaration of [
    undefined, null, {}, [null], [{}], [{ uri: '' }], [{ uri: ' \n' }],
    [{ uri: 'artifact://report', title: 42 }],
  ]) {
    const invalid = new ToolMessage({ ...original, artifact: {
      ...record, result: { ...record.result, deliverables: declaration },
    } });
    assert.throws(() => readCapabilityExecutionRecord(invalid), /Corrupted delegate_capability record/);
  }
});
