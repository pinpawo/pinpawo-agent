import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAgentClientMessage } from './protocol';

test('chat_request accepts an explicit active delegation transition', () => {
  assert.deepEqual(parseAgentClientMessage({
    type: 'chat_request',
    requestId: 'request-1',
    message: '继续旧任务',
    activeDelegationTransition: 'resume_active',
  }), {
    type: 'chat_request',
    requestId: 'request-1',
    message: '继续旧任务',
    activeDelegationTransition: 'resume_active',
  });
});

test('chat_request rejects an unknown active delegation transition', () => {
  assert.equal(parseAgentClientMessage({
    type: 'chat_request',
    requestId: 'request-1',
    message: '继续旧任务',
    activeDelegationTransition: 'guess_from_text',
  }), null);
});
