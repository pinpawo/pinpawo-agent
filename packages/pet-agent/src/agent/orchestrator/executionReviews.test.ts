import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { setAgentMessageMetadata } from '../messages';
import { createCapabilityExecutionMessage } from './executionMessages';
import { readAcceptedRunDeliverables } from './executionReviews';

function execution(id: string, runId = 'run', uri = `artifact://${id}`) {
  const metadata = { runId, taskId: 'task' };
  const call = setAgentMessageMetadata(new AIMessage({ content: '', tool_calls: [{
    id: `execute-${id}`, name: 'delegate_capability', args: { briefing: 'Publish.' },
  }] }), metadata);
  const result = createCapabilityExecutionMessage({ callId: `execute-${id}`, metadata,
    execution: { delegationId: id, planItemId: 'plan', capability: 'general', task: 'Publish.', briefing: 'Publish.' },
    result: { status: 'returned', deliverables: [{ uri, title: id }], delivery: {
      id: `delivery-${id}`, task: 'Publish.', text: 'Published.',
      scope: { ...metadata, delegationId: id, lane: 'capability:general' },
    } },
  });
  return [call, result];
}

function review(id: string, options: { runId?: string; completed?: boolean; error?: boolean } = {}) {
  const metadata = { runId: options.runId ?? 'run', lane: 'supervisor' };
  return [setAgentMessageMetadata(new AIMessage({ content: '', tool_calls: [{
    id: `review-${id}`, name: 'review_current', args: { completed: options.completed ?? true, reason: 'Checked.' },
  }] }), metadata), setAgentMessageMetadata(new ToolMessage({ name: 'review_current', tool_call_id: `review-${id}`,
    content: 'Plan updated.', artifact: { acceptedDelegationId: id },
    ...(options.error ? { status: 'error' } : {}),
  }), metadata)];
}

test('public references select only same-run successful acceptance records, not returned attempts', () => {
  const rejected = execution('rejected');
  const accepted = execution('accepted');
  const history = [...execution('old', 'old-run'), ...review('old', { runId: 'old-run' }),
    ...rejected, ...review('rejected', { completed: false }),
    ...execution('failed-review'), ...review('failed-review', { error: true }),
    ...accepted, ...review('accepted')];
  assert.deepEqual(readAcceptedRunDeliverables(history, 'run'), [{ uri: 'artifact://accepted', title: 'accepted' }]);
  assert.deepEqual(readAcceptedRunDeliverables(accepted, 'run'), []);
  assert.deepEqual(readAcceptedRunDeliverables([...accepted, review('accepted')[1]!], 'run'), []);
});

test('accepted references preserve execution order and keep the first occurrence of a URI', () => {
  const messages = [...execution('first', 'run', 'artifact://shared'), ...review('first'),
    ...execution('second'), ...review('second'), ...execution('third', 'run', 'artifact://shared'), ...review('third')];
  assert.deepEqual(readAcceptedRunDeliverables(messages, 'run'), [
    { uri: 'artifact://shared', title: 'first' }, { uri: 'artifact://second', title: 'second' },
  ]);
});


test('a current-run review may accept a saved earlier execution without carrying old acceptances forward', () => {
  const saved = [...execution('earlier', 'old-run'), ...review('earlier', { runId: 'old-run' })];
  assert.deepEqual(readAcceptedRunDeliverables(saved, 'continued-run'), []);
  assert.deepEqual(readAcceptedRunDeliverables([...saved, ...review('earlier', { runId: 'continued-run' })], 'continued-run'), [
    { uri: 'artifact://earlier', title: 'earlier' },
  ]);
});
