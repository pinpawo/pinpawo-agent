import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_LOCAL_ATTACHMENT_LIMIT,
  parseAgentClientMessage,
  parseAgentServerMessage,
} from './index';

test('chat request parser accepts bounded local path attachments', () => {
  assert.deepEqual(parseAgentClientMessage({
    type: 'chat_request',
    requestId: 'request-1',
    message: '',
    attachments: [{
      id: 'attachment-1',
      source: 'local-path',
      kind: 'file',
      path: '/tmp/spec.md',
      name: 'spec.md',
    }],
  }), {
    type: 'chat_request',
    requestId: 'request-1',
    message: '',
    attachments: [{
      id: 'attachment-1',
      source: 'local-path',
      kind: 'file',
      path: '/tmp/spec.md',
      name: 'spec.md',
    }],
  });
});

test('chat request parser rejects relative, duplicate, and excessive attachments', () => {
  const attachment = {
    id: 'attachment-1',
    source: 'local-path',
    kind: 'file',
    path: '/tmp/spec.md',
    name: 'spec.md',
  } as const;
  assert.equal(parseAgentClientMessage({
    type: 'chat_request',
    requestId: 'request-1',
    message: 'hello',
    attachments: [{ ...attachment, path: 'relative/spec.md' }],
  }), null);
  assert.equal(parseAgentClientMessage({
    type: 'chat_request',
    requestId: 'request-1',
    message: 'hello',
    attachments: [attachment, { ...attachment }],
  }), null);
  assert.equal(parseAgentClientMessage({
    type: 'chat_request',
    requestId: 'request-1',
    message: 'hello',
    attachments: Array.from(
      { length: AGENT_LOCAL_ATTACHMENT_LIMIT + 1 },
      (_, index) => ({
        ...attachment,
        id: `attachment-${index}`,
        path: `/tmp/spec-${index}.md`,
      }),
    ),
  }), null);
});

test('runtime config protocol supports legacy updates and correlated acknowledgements', () => {
  assert.deepEqual(parseAgentClientMessage({
    type: 'runtime_config.update',
    globalReviewPolicyMode: 'require_authorization',
  }), {
    type: 'runtime_config.update',
    globalReviewPolicyMode: 'require_authorization',
  });
  assert.deepEqual(parseAgentClientMessage({
    type: 'runtime_config.update',
    requestId: 'policy-1',
    globalReviewPolicyMode: 'auto_authorization',
  }), {
    type: 'runtime_config.update',
    requestId: 'policy-1',
    globalReviewPolicyMode: 'auto_authorization',
  });
  assert.equal(parseAgentClientMessage({
    type: 'runtime_config.update',
    requestId: 42,
    globalReviewPolicyMode: 'auto_authorization',
  }), null);
  assert.equal(parseAgentClientMessage({
    type: 'runtime_config.update',
    requestId: '',
    globalReviewPolicyMode: 'auto_authorization',
  }), null);
  assert.deepEqual(parseAgentServerMessage({
    type: 'runtime_config.result',
    requestId: 'policy-1',
    globalReviewPolicyMode: 'auto_authorization',
  }), {
    type: 'runtime_config.result',
    requestId: 'policy-1',
    globalReviewPolicyMode: 'auto_authorization',
  });
  assert.deepEqual(parseAgentServerMessage({
    type: 'runtime_config.error',
    requestId: 'policy-2',
    message: 'config is read-only',
  }), {
    type: 'runtime_config.error',
    requestId: 'policy-2',
    message: 'config is read-only',
  });
});
