import assert from 'node:assert/strict';
import test from 'node:test';
import { getAgentMessageMetadata } from '../messages';
import { createInvocationContextMessage } from './invocationContext';

test('createInvocationContextMessage stamps the shared invocation-only contract', () => {
  const message = createInvocationContextMessage({
    id: 'planner:input-1',
    name: 'planner_input',
    content: '<planner_input />',
  });

  assert.equal(message.id, 'planner:input-1');
  assert.equal(message.name, 'planner_input');
  assert.equal(message.text, '<planner_input />');
  assert.deepEqual(getAgentMessageMetadata(message), {
    source: 'planner_input',
    synthetic: true,
    invocationOnly: true,
    authority: 'none',
  });
});

test('createInvocationContextMessage rejects empty domain inputs', () => {
  assert.throws(
    () => createInvocationContextMessage({ name: '', content: '<input />' }),
    /name must be non-empty/,
  );
  assert.throws(
    () => createInvocationContextMessage({ name: 'input', content: ' ' }),
    /content must be non-empty/,
  );
});
